"""通过一次 SSH 登录，在指定测试机验收当前四个步骤。

本地依赖 paramiko。密码交互输入，仅保留在内存中；报告不包含密码。
"""

import argparse
import base64
from datetime import datetime, timezone
import getpass
import hashlib
import json
from pathlib import Path, PurePosixPath
import shlex
import sys
import time
import uuid

import paramiko


PROJECT = Path(__file__).resolve().parents[1]


def fingerprint(key):
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


class PinnedHostKey(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected

    def missing_host_key(self, client, hostname, key):
        actual = fingerprint(key)
        if actual != self.expected:
            raise paramiko.SSHException("Host fingerprint mismatch: " + actual)


def execute(client, command, timeout=660):
    """持续读取输出，避免下载进度填满 SSH 通道而卡住。"""
    channel = client.get_transport().open_session(timeout=15)
    channel.exec_command(command)
    output, errors = [], []
    deadline = time.monotonic() + timeout
    try:
        while True:
            while channel.recv_ready():
                output.append(channel.recv(65536))
            while channel.recv_stderr_ready():
                errors.append(channel.recv_stderr(65536))
            # 退出状态可能先于最后一段输出到达；等 EOF/关闭并读空缓冲区。
            if (channel.exit_status_ready() and (channel.eof_received or channel.closed)
                    and not channel.recv_ready() and not channel.recv_stderr_ready()):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Remote command exceeded its time limit")
            time.sleep(0.1)
        return {
            "exit_code": channel.recv_exit_status(),
            "stdout": b"".join(output).decode("utf-8", errors="replace"),
            "stderr": b"".join(errors).decode("utf-8", errors="replace"),
        }
    finally:
        channel.close()


def test_service(stage, remote_directory, report):
    """验证服务注册和自启，保留安装前的运行状态及协议配置。"""
    installer = shlex.quote(remote_directory + "/scripts/04-install-service.sh")
    plan = stage("service installation preview", "sh " + installer + " --dry-run")
    paths = dict(line.split("=", 1) for line in plan.splitlines() if "=" in line)
    manager = paths["SERVICE_MANAGER"]
    service_file = shlex.quote(paths["SERVICE_FILE"])
    config = shlex.quote(paths["CONFIG_PATH"])
    report["service_manager"] = manager
    report["service_file"] = paths["SERVICE_FILE"]
    report["config_path"] = paths["CONFIG_PATH"]

    config_command = "if [ -f " + config + " ]; then sha256sum " + config + "; else printf 'missing\\n'; fi"
    if manager == "openrc":
        state_command = "if rc-service -q sing-box status >/dev/null 2>&1; then printf 'active\\n'; else printf 'stopped\\n'; fi"
        enable_command = "set -eu\ntest -L /etc/runlevels/default/sing-box\nrc-status default"
        syntax_command = "sh -n " + service_file
    else:
        state_command = "if systemctl is-active --quiet sing-box.service; then printf 'active\\n'; else printf 'stopped\\n'; fi"
        enable_command = "set -eu\nsystemctl is-enabled sing-box.service\nsystemctl show -p ActiveState sing-box.service"
        syntax_command = "systemd-analyze verify " + service_file
    original_config = stage("record configuration state", config_command)
    original_state = stage("record service state", state_command)
    if not original_config.strip() or original_state.strip() not in ("active", "stopped"):
        raise RuntimeError("Service or configuration observation returned incomplete output")
    stage("install service and enable boot startup", "sh " + installer)
    stage("verify native service definition", syntax_command)
    state_file_command = "set -eu\nsha256sum " + service_file + "\nstat -c '%i:%Y' " + service_file
    before = stage("record installed service file", state_file_command)
    stage("repeat service installation", "sh " + installer)
    after = stage("verify repeat preserves service file", state_file_command)
    if before != after:
        raise RuntimeError("Repeat installation rewrote the service file")
    stage("verify persistent boot startup registration", enable_command)
    if stage("verify service state is preserved", state_command) != original_state:
        raise RuntimeError("Service installer changed its running state")
    if stage("verify configuration is preserved", config_command) != original_config:
        raise RuntimeError("Service installer changed the protocol configuration")
    report["service_state"] = original_state.strip()
    report["configuration_present"] = original_config.strip() != "missing"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--fingerprint", required=True, help="Previously verified SHA256 host fingerprint")
    parser.add_argument("--password-stdin", action="store_true", help="Read one password line from stdin")
    parser.add_argument("--verbose", action="store_true", help="Print each test stage as it completes")
    parser.add_argument("--service-only", action="store_true", help="Test service registration using the installed core")
    parser.add_argument("--reset-checks-only", action="store_true", help="Run isolated reset tests and a real read-only preview")
    args = parser.parse_args()
    if args.service_only and args.reset_checks_only:
        parser.error("Choose one test mode")

    # 不从命令行参数、配置文件或环境变量读取密码。
    print("Testing " + args.host, flush=True)
    password = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else getpass.getpass("SSH password: ")
    if not password:
        raise ValueError("An SSH password is required")

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    remote_directory = "/tmp/singbox-manual-test-" + run_id
    report_directory = PROJECT / "generated" / "live-tests"
    report_directory.mkdir(parents=True, exist_ok=True)
    report_path = report_directory / (args.host + "-" + run_id + ".json")
    report = {
        "host": args.host,
        "port": args.port,
        "host_fingerprint": args.fingerprint,
        "remote_directory": remote_directory,
        "stages": [],
        "passed": False,
    }
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedHostKey(args.fingerprint))

    def stage(name, command, expected_code=0):
        result = execute(client, command)
        result["name"] = name
        report["stages"].append(result)
        if result["exit_code"] != expected_code:
            print((result["stdout"] + result["stderr"])[-6000:], flush=True)
            raise RuntimeError("Stage failed: " + name)
        if args.verbose:
            print("PASS: " + name, flush=True)
        return result["stdout"]

    try:
        # 1. 校验预先确认的指纹，只进行一次密码认证。
        client.connect(args.host, port=args.port, username="root", password=password,
                       look_for_keys=False, allow_agent=False, timeout=15,
                       banner_timeout=15, auth_timeout=20)
        password = None

        # 2. 上传明确列出的代码文件，复用此 SSH 连接的 SFTP 通道。
        with client.open_sftp() as sftp:
            sftp.mkdir(remote_directory, mode=0o700)
            for folder in ("scripts", "lib", "tests", "service", "config", "docs"):
                sftp.mkdir(remote_directory + "/" + folder, mode=0o700)
            files = [PROJECT / "README.md", PROJECT / "install.sh", PROJECT / "check.sh", PROJECT / "docs/manual.md"]
            for folder in ("scripts", "lib", "tests"):
                files.extend(sorted((PROJECT / folder).glob("*.sh")))
            files.extend([PROJECT / "service/sing-box.openrc", PROJECT / "service/sing-box.service"])
            files.extend([PROJECT / "config/README.md", PROJECT / "config/server.template.json"])
            for local in files:
                relative = local.relative_to(PROJECT).as_posix()
                sftp.put(str(local), remote_directory + "/" + relative)

        script = shlex.quote(remote_directory + "/scripts/02-download-core.sh")
        stage("environment and shell checks", "sh " + shlex.quote(remote_directory + "/check.sh"))
        if args.reset_checks_only:
            # 只在隔离目录执行清理；真实部署仅做预览和前后对比。
            snapshot_command = '''set -eu
for path in /usr/local/bin/sing-box /opt/singbox/core/current /etc/init.d/sing-box /etc/systemd/system/sing-box.service /etc/runlevels/default/sing-box /etc/systemd/system/multi-user.target.wants/sing-box.service; do
    if [ -L "$path" ]; then printf '%s -> %s\\n' "$path" "$(readlink "$path")";
    elif [ -f "$path" ]; then sha256sum "$path"; fi
done
if [ -f /etc/init.d/sing-box ]; then
    if rc-service -q sing-box status >/dev/null 2>&1; then printf 'active\\n'; else printf 'stopped\\n'; fi
else
    if systemctl is-active --quiet sing-box.service; then printf 'active\\n'; else printf 'stopped\\n'; fi
fi
'''
            before = stage("record current real deployment", snapshot_command)
            stage("isolated Debian and Alpine reset checks", "sh " + shlex.quote(remote_directory + "/tests/reset-environment.sh"))
            stage("real deployment reset preview only", "sh " + shlex.quote(remote_directory + "/scripts/00-reset-environment.sh") + " --dry-run")
            after = stage("verify real deployment is unchanged", snapshot_command)
            if before != after:
                raise RuntimeError("Reset tests changed the real deployment")
            report["real_reset_executed"] = False
            report["passed"] = True
            print("PASS: " + args.host + " (isolated reset checks; real deployment unchanged)", flush=True)
            return 0
        if args.service_only:
            test_service(stage, remote_directory, report)
            report["passed"] = True
            print("PASS: " + args.host + " (" + str(len(report["stages"])) + " stages)", flush=True)
            return 0

        # 3. 预览必须没有文件变更，然后执行真实官方核心下载和校验。
        dry_root = shlex.quote(remote_directory + "/preview-only")
        stage("preview creates no output directory",
              "set -eu\nCORE_ROOT=" + dry_root + " sh " + script + " --dry-run\ntest ! -e " + dry_root)
        preview = stage("default download plan", "sh " + script + " --dry-run")
        core_paths = [line.split("=", 1)[1] for line in preview.splitlines() if line.startswith("CORE_PATH=")]
        if (len(core_paths) != 1 or not PurePosixPath(core_paths[0]).is_absolute()
                or PurePosixPath(core_paths[0]).name != "sing-box"):
            raise RuntimeError("Unexpected core path in preview")
        core = shlex.quote(core_paths[0])
        report["core_path"] = core_paths[0]
        stage("official download, archive checksum and native core execution", "sh " + script)
        before = stage("record installed core hash and metadata", "set -eu\nsha256sum " + core + "\nstat -c '%Y:%s:%a' " + core)

        # 4. 第二次真实下载，确认相同核心不会被重写。
        repeated = stage("repeat download reuses the same verified core", "sh " + script)
        if "The same verified core is already present." not in repeated:
            raise RuntimeError("Repeat run did not report reuse")
        after = stage("verify unchanged core hash and metadata", "set -eu\nsha256sum " + core + "\nstat -c '%Y:%s:%a' " + core)
        if before != after:
            raise RuntimeError("Repeat run changed the installed core")
        stage("installed core version", core + " version")

        # 5. 给下载工具返回损坏内容，实际 SHA-256 校验必须阻止安装。
        failure_root = remote_directory + "/failure-core"
        with client.open_sftp() as sftp:
            sftp.mkdir(remote_directory + "/fake-bin", mode=0o700)
            with sftp.open(remote_directory + "/fake-bin/curl", "w") as fake:
                fake.write('''#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then
        printf 'deliberately corrupted test archive' > "$2"
        exit 0
    fi
    shift
done
exit 2
''')
            sftp.chmod(remote_directory + "/fake-bin/curl", 0o700)
        command = ("PATH=" + shlex.quote(remote_directory + "/fake-bin") + ':"$PATH" CORE_ROOT='
                   + shlex.quote(failure_root) + " sh " + script)
        result = execute(client, command)
        result["name"] = "corrupt archive is rejected"
        report["stages"].append(result)
        if result["exit_code"] == 0 or "FAILED" not in result["stdout"] + result["stderr"]:
            raise RuntimeError("Corrupt archive was not rejected by checksum validation")
        if args.verbose:
            print("PASS: corrupt archive is rejected", flush=True)
        stage("failed download leaves no installed core or staging files",
              "set -eu\ntest -d " + shlex.quote(failure_root)
              + "\ntest -z \"$(find " + shlex.quote(failure_root) + " -mindepth 1 -print)\"")

        # 6. 先在隔离目录测试链接冲突和回滚，再执行真实安装。
        stage("isolated install conflicts, repeat and rollback checks",
              "sh " + shlex.quote(remote_directory + "/tests/install-core.sh"))
        installer = shlex.quote(remote_directory + "/scripts/03-install-core.sh")
        installation_plan = stage("fixed entry installation preview", "sh " + installer + " --dry-run")
        installation_paths = dict(line.split("=", 1) for line in installation_plan.splitlines() if "=" in line)
        current = shlex.quote(installation_paths["CURRENT_LINK"])
        command_link = shlex.quote(installation_paths["COMMAND_LINK"])
        report["current_link"] = installation_paths["CURRENT_LINK"]
        report["command_link"] = installation_paths["COMMAND_LINK"]
        stage("install fixed entry and sing-box command", "sh " + installer)
        link_state_command = ("set -eu\nreadlink " + current + "\nreadlink " + command_link
                              + "\nstat -c '%i:%Y' " + current + " " + command_link)
        links_before = stage("record installed links", link_state_command)
        stage("repeat installation", "sh " + installer)
        links_after = stage("verify installation preserves existing correct links", link_state_command)
        if links_before != links_after:
            raise RuntimeError("Repeat installation replaced existing links")
        selected_command = stage("verify sing-box from PATH", "set -eu\ncommand -v sing-box\nsing-box version")
        if selected_command.splitlines()[0] != installation_paths["COMMAND_LINK"]:
            raise RuntimeError("PATH selected a different sing-box command")
        test_service(stage, remote_directory, report)
        report["passed"] = True
        print("PASS: " + args.host + " (" + str(len(report["stages"])) + " stages)", flush=True)
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        print("FAIL: " + report["error"], flush=True)
    finally:
        password = None
        client.close()
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("REPORT: " + str(report_path), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
