"""一键安装实机验收：临时路径和唯一服务名，完整安装后清理临时服务。"""

import argparse
import getpass
import importlib.util
import json
from pathlib import Path
import random
import shlex
import uuid

import paramiko


PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("configuration_tests", PROJECT / "tools/test-configuration.py")
configuration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configuration)
runner = configuration.runner


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--fingerprint", required=True)
    args = parser.parse_args()
    print("Testing " + args.host, flush=True)
    password = getpass.getpass("SSH password: ")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(runner.PinnedHostKey(args.fingerprint))
    run_id = uuid.uuid4().hex[:12]
    remote = "/tmp/singbox-manual-install-test-" + run_id
    name = "singbox-install-test-" + run_id
    report = {"host": args.host, "remote_directory": remote, "temporary_service": name,
              "stages": [], "passed": False, "nat_changed": False}
    report_path = PROJECT / "generated/live-tests" / ("install-" + args.host + "-" + run_id + ".json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    sftp = None
    service_file = None
    manager = None
    cleanup_allowed = False

    def stage(label, command, success=True):
        result = runner.execute(client, command)
        result["name"] = label
        report["stages"].append(result)
        if (result["exit_code"] == 0) != success:
            raise RuntimeError("Stage failed: " + label + "\n" + result["stderr"])
        return result["stdout"]

    def write(path, content):
        with sftp.open(path, "w") as stream:
            stream.write(content)
        sftp.chmod(path, 0o600)

    try:
        client.connect(args.host, port=args.port, username="root", password=password,
                       look_for_keys=False, allow_agent=False, timeout=15, auth_timeout=20)
        password = None
        sftp = client.open_sftp()
        sftp.mkdir(remote, mode=0o700)
        for directory in ("scripts", "lib", "service", "config", "tests", "bin"):
            sftp.mkdir(remote + "/" + directory, mode=0o700)
        for relative in ("scripts/01-inspect.sh", "lib/platform.sh"):
            sftp.put(str(PROJECT / relative), remote + "/" + relative)
        platform = stage("inspect native platform", "sh " + remote + "/scripts/01-inspect.sh --summary")
        manager = dict(line.split("=", 1) for line in platform.splitlines())["ACTIVE_SERVICE_MANAGER"]
        if manager not in ("systemd", "openrc"):
            raise RuntimeError("A native service manager is required")
        report["service_manager"] = manager
        service_file = "/etc/systemd/system/" + name + ".service" if manager == "systemd" else "/etc/init.d/" + name
        stage("ensure unique temporary service name", "test ! -e " + service_file + " && test ! -L " + service_file)
        cleanup_allowed = True
        footprint = '''set -eu
for file in /etc/sing-box/config.json /etc/sing-box/credentials.env /etc/init.d/sing-box /etc/systemd/system/sing-box.service; do
    if [ -f "$file" ]; then sha256sum "$file"; fi
done
for link in /usr/local/bin/sing-box /opt/singbox/core/current; do
    if [ -L "$link" ]; then readlink "$link"; fi
done
if [ -d /run/openrc ]; then
    if rc-service -q sing-box status >/dev/null 2>&1; then printf 'active\\n'; else printf 'inactive\\n'; fi
    if [ -L /etc/runlevels/default/sing-box ]; then readlink /etc/runlevels/default/sing-box; fi
else
    systemctl is-active sing-box.service || true
    systemctl is-enabled sing-box.service || true
fi
'''
        before = stage("record formal deployment", footprint)
        replacements = {
            "/opt/singbox/core": remote + "/core",
            "/usr/local/bin": remote + "/bin",
            "/etc/sing-box": remote + "/state",
            "/var/lib/sing-box": remote + "/data",
            "/var/log/sing-box": remote + "/logs",
            "/run/sing-box.pid": "/run/" + name + ".pid",
            "/etc/init.d/sing-box": "/etc/init.d/" + name,
            "/etc/runlevels/default/sing-box": "/etc/runlevels/default/" + name,
            "sing-box.service": name + ".service",
            "rc-service sing-box": "rc-service " + name,
            "rc-service -q sing-box": "rc-service -q " + name,
            "rc-update add sing-box default": "rc-update add " + name + " default",
        }

        # 在临时副本中统一替换路径，官方 URL、校验值和执行逻辑保持原样。
        files = [PROJECT / "install.sh", PROJECT / "check.sh", PROJECT / "config/server.template.json"]
        for directory in ("scripts", "lib", "service", "tests"):
            files.extend(path for path in (PROJECT / directory).iterdir() if path.suffix in (".sh", ".service", ".openrc"))
        for path in files:
            relative = path.relative_to(PROJECT).as_posix()
            text = path.read_text(encoding="utf-8")
            # 入口回归必须验证生产入口，不适配其中固定路径的保护规则。
            if relative != "tests/install-entry.sh":
                for old, new in replacements.items():
                    text = text.replace(old, new)
            relative = relative.replace("sing-box.service", name + ".service")
            write(remote + "/" + relative, text)

        # 入口回归在另一份原始入口上模拟路径和包管理器，不触及正式部署。
        sftp.mkdir(remote + "/regression", mode=0o700)
        for directory in ("scripts", "lib", "service", "config", "tests"):
            sftp.mkdir(remote + "/regression/" + directory, mode=0o700)
        regression_files = [PROJECT / "install.sh", PROJECT / "lib/platform.sh", PROJECT / "config/server.template.json",
                            PROJECT / "service/sing-box.service", PROJECT / "service/sing-box.openrc", PROJECT / "tests/install-entry.sh"]
        for path in regression_files:
            sftp.put(str(path), remote + "/regression/" + path.relative_to(PROJECT).as_posix())
        stage("isolated installer regression", "sh " + remote + "/regression/tests/install-entry.sh")
        stage("shell syntax and platform checks", "sh " + remote + "/check.sh --offline")
        occupied = configuration.listening_ports(sftp)
        ports = random.sample([p for p in range(30000, 59000) if p not in occupied], 2)
        # 排除正式 /usr/local/bin，确保第三步不会选到正式安装的同名命令。
        prefix = "PATH=" + remote + "/bin:/usr/sbin:/usr/bin:/sbin:/bin ANYTLS_PORT=" + str(ports[0]) + " VLESS_PORT=" + str(ports[1]) + " "
        install = prefix + "sh " + remote + "/install.sh"
        stage("preview without installation", "set -eu\n" + install + " --dry-run\ntest ! -e " + remote
              + "/core\ntest ! -e " + remote + "/state\ntest ! -e " + service_file)
        stage("complete real one-click installation", install)
        identity = "set -eu\nsha256sum " + remote + "/state/config.json " + remote + "/state/credentials.env\nstat -c '%Y:%s:%a' " + remote + "/state/config.json " + remote + "/state/credentials.env"
        original_identity = stage("record configuration identity and permissions", identity)
        if not original_identity.rstrip().endswith(":600"):
            raise RuntimeError("Credentials permissions are not private")
        state = "systemctl show -p MainPID --value " + name + ".service" if manager == "systemd" else "cat /run/" + name + ".pid"
        first_pid = stage("record first service process", state).strip()
        stage("repeat complete one-click installation", install)
        if stage("verify identity and file metadata are reused", identity) != original_identity:
            raise RuntimeError("Repeated installation changed identity or files")
        second_pid = stage("verify service is restarted", state).strip()
        if second_pid in ("0", first_pid):
            raise RuntimeError("Expected restart on repeated installation")
        stage("final read-only service and listener check", prefix + "sh " + remote + "/scripts/06-start-service.sh --check")
        if stage("verify check preserves service process", state).strip() != second_pid:
            raise RuntimeError("Check restarted the service")
        after = stage("verify formal deployment is unchanged", footprint)
        if after != before:
            raise RuntimeError("Formal deployment changed")
        report["passed"] = True
    except Exception as error:
        report["error"] = str(error)
        print("FAIL: " + str(error), flush=True)
    finally:
        if cleanup_allowed and client.get_transport() and client.get_transport().is_active():
            cleanup = "set -eu\nif [ -f " + service_file + " ]; then\n"
            if manager == "systemd":
                cleanup += "systemctl stop " + name + ".service\nsystemctl disable " + name + ".service\n"
            else:
                cleanup += "if rc-service -q " + name + " status >/dev/null 2>&1; then rc-service " + name + " stop; fi\nrc-update del " + name + " default\n"
            cleanup += "rm -f " + service_file + "\n"
            if manager == "systemd":
                cleanup += "systemctl daemon-reload\n"
            cleanup += "fi\ntest ! -e " + service_file
            result = runner.execute(client, cleanup)
            report["cleanup"] = result
            if result["exit_code"]:
                report["passed"] = False
        password = None
        if sftp:
            sftp.close()
        client.close()
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        if report["passed"]:
            print("PASS: " + args.host + " (" + str(len(report["stages"])) + " stages; temporary service removed)", flush=True)
        print("Report: " + str(report_path), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
