"""第五步实机验收：隔离生成配置，使用本机回环连接验证双协议，不修改 NAT。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import getpass
import importlib.util
import json
from pathlib import Path
import random
import shlex
import time
import uuid

import paramiko


PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ssh_runner", PROJECT / "tools/test-server.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def listening_ports(sftp):
    ports = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with sftp.open(path, "r") as stream:
                for line in stream.read().decode().splitlines()[1:]:
                    fields = line.split()
                    if fields[3] == "0A":
                        ports.add(int(fields[1].split(":")[1], 16))
        except FileNotFoundError:
            pass
    return ports


def fetch_through_proxy(client, port):
    """从服务器本机请求代理，不依赖 SSH TCP 转发或公网映射。"""
    command = ("curl -q --fail --silent --show-error --max-time 25 --noproxy '' --proxy "
               + shlex.quote("http://127.0.0.1:" + str(port))
               + " --write-out " + shlex.quote("\nHTTP_STATUS=%{http_code}\n")
               + " https://example.com/")
    result = runner.execute(client, command, timeout=40)
    if result["exit_code"] != 0:
        raise RuntimeError("Loopback HTTPS probe failed: " + result["stderr"])
    if "\nHTTP_STATUS=200\n" not in result["stdout"] or "Example Domain" not in result["stdout"]:
        raise RuntimeError("Unexpected destination response")
    return "HTTP 200; certificate verified by curl; Example Domain received"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--fingerprint", required=True)
    parser.add_argument("--reality-server", default="www.apple.com")
    args = parser.parse_args()
    print("Testing " + args.host, flush=True)
    password = getpass.getpass("SSH password: ")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(runner.PinnedHostKey(args.fingerprint))
    run_id = uuid.uuid4().hex[:16]
    remote = "/tmp/singbox-manual-config-test-" + run_id
    report = {"host": args.host, "remote_directory": remote, "reality_server": args.reality_server,
              "stages": [], "passed": False, "nat_changed": False, "real_configuration_changed": False}
    processes = []
    secrets = []
    sftp = None
    reports = PROJECT / "generated/live-tests"
    reports.mkdir(parents=True, exist_ok=True)
    report_path = reports / ("configuration-" + args.host + "-" + run_id + ".json")

    def stage(name, command, success=True):
        result = runner.execute(client, command)
        result["name"] = name
        report["stages"].append(result)
        if (result["exit_code"] == 0) != success:
            raise RuntimeError("Stage failed: " + name + "\n" + result["stderr"])
        return result["stdout"]

    def write_json(path, content):
        with sftp.open(path, "w") as stream:
            stream.write(json.dumps(content, indent=2))
        sftp.chmod(path, 0o600)

    def read_bytes(path):
        with sftp.open(path, "r") as stream:
            return stream.read()

    def stop(pid):
        result = runner.execute(client, "if [ -r /proc/" + str(pid) + "/cmdline ] && tr '\\000' ' ' < /proc/"
                       + str(pid) + "/cmdline | grep -Fq " + shlex.quote(remote)
                       + "; then kill " + str(pid) + "; fi")
        if result["exit_code"] != 0:
            raise RuntimeError("Could not stop isolated test process " + str(pid))

    def start(core, config, label, ports):
        directory = remote + "/" + label + "-data"
        logfile = remote + "/" + label + ".log"
        command = ("set -eu\nmkdir -p " + shlex.quote(directory) + "\ntrap '' HUP\n"
                   + shlex.quote(core) + " run -c " + shlex.quote(config) + " -D " + shlex.quote(directory)
                   + " >" + shlex.quote(logfile) + " 2>&1 </dev/null &\nprintf '%s\\n' \"$!\"")
        pid = int(stage("start isolated " + label, command).strip())
        processes.append(pid)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if set(ports).issubset(listening_ports(sftp)):
                return pid
            time.sleep(0.3)
        raise RuntimeError("Isolated process did not open its loopback ports: " + label)

    try:
        client.connect(args.host, port=args.port, username="root", password=password,
                       look_for_keys=False, allow_agent=False, timeout=15, auth_timeout=20)
        password = None
        sftp = client.open_sftp()
        sftp.mkdir(remote, mode=0o700)
        for folder in ("scripts", "config"):
            sftp.mkdir(remote + "/" + folder, mode=0o700)
        for relative in ("scripts/05-configure-server.sh", "config/server.template.json"):
            sftp.put(str(PROJECT / relative), remote + "/" + relative)

        # 用户可能已经清理当前安装，测试可复用之前验证过的独立核心文件。
        candidates = ["/usr/local/bin/sing-box"]
        for base in ("/opt/singbox/core", "/opt/singbox-manual/core"):
            for libc in ("glibc", "musl"):
                candidates.append(base + "/1.14.3-linux-amd64-" + libc + "/sing-box")
        selection = "for core in " + " ".join(shlex.quote(path) for path in candidates) + "; do\n"
        selection += 'if [ -x "$core" ] && "$core" version 2>/dev/null | grep -Fxq "sing-box version 1.14.3"; then printf "%s\\n" "$core"; exit 0; fi\ndone\nexit 1'
        core = stage("locate existing verified-version core", selection).strip()
        report["core"] = core
        footprint = '''set -eu
for path in /etc/sing-box/config.json /etc/sing-box/credentials.env /etc/init.d/sing-box /etc/systemd/system/sing-box.service; do
    if [ -f "$path" ]; then sha256sum "$path"; fi
done
if [ -L /usr/local/bin/sing-box ]; then readlink /usr/local/bin/sing-box; fi
'''
        before = stage("record real configuration footprint", footprint)
        occupied = listening_ports(sftp)
        ports = random.sample([port for port in range(30000, 59000) if port not in occupied], 5)
        state_dir = remote + "/state"
        script = remote + "/scripts/05-configure-server.sh"
        prefix = ("SING_BOX=" + shlex.quote(core) + " CONFIG_DIR=" + shlex.quote(state_dir)
                  + " REALITY_SERVER=" + shlex.quote(args.reality_server) + " ")
        stage("preview creates no files", "set -eu\n" + prefix + "sh " + shlex.quote(script)
              + " --dry-run\ntest ! -e " + shlex.quote(state_dir))
        stage("generate and validate actual dual-protocol configuration",
              prefix + "ANYTLS_PORT=" + str(ports[0]) + " VLESS_PORT=" + str(ports[1])
              + " sh " + shlex.quote(script))
        credentials = dict(line.split("=", 1) for line in read_bytes(state_dir + "/credentials.env").decode().splitlines())
        secrets.extend(credentials[key] for key in ("ANYTLS_PASSWORD", "VLESS_UUID", "REALITY_PRIVATE_KEY"))
        config = json.loads(read_bytes(state_dir + "/config.json"))
        assert [item["type"] for item in config["inbounds"]] == ["anytls", "vless"]
        assert all(len(item["users"]) == 1 and item["users"][0]["name"] == "shared" for item in config["inbounds"])
        assert config["outbounds"] == [{"type": "direct", "tag": "direct"}]
        assert config["route"]["final"] == "direct"
        assert config["inbounds"][1]["users"][0]["flow"] == "xtls-rprx-vision"
        for name in ("config.json", "credentials.env"):
            assert sftp.stat(state_dir + "/" + name).st_mode & 0o777 == 0o600
        original = [(read_bytes(state_dir + "/" + name), sftp.stat(state_dir + "/" + name).st_mtime)
                    for name in ("config.json", "credentials.env")]
        stage("repeat preserves credentials and files", prefix + "sh " + shlex.quote(script))
        assert original == [(read_bytes(state_dir + "/" + name), sftp.stat(state_dir + "/" + name).st_mtime)
                            for name in ("config.json", "credentials.env")]
        stage("conflicting ports are rejected", prefix + "ANYTLS_PORT=1 VLESS_PORT=1 sh " + shlex.quote(script), success=False)
        assert original[0][0] == read_bytes(state_dir + "/config.json")

        # 修改一个参数必须备份旧配置，并继续使用同一套认证信息。
        stage("port change backs up configuration", prefix + "ANYTLS_PORT=" + str(ports[2])
              + " sh " + shlex.quote(script))
        updated = dict(line.split("=", 1) for line in read_bytes(state_dir + "/credentials.env").decode().splitlines())
        for key in ("ANYTLS_PASSWORD", "VLESS_UUID", "REALITY_PRIVATE_KEY", "REALITY_PUBLIC_KEY", "REALITY_SHORT_ID"):
            assert updated[key] == credentials[key]
        backups = sftp.listdir(state_dir + "/backups")
        assert len(backups) == 1
        assert read_bytes(state_dir + "/backups/" + backups[0] + "/config.json") == original[0][0]
        current_files = [read_bytes(state_dir + "/" + name) for name in ("config.json", "credentials.env")]

        # 候选配置检查失败时，原配置和原身份都保留。
        invalid_project = remote + "/invalid-template"
        for path in (invalid_project, invalid_project + "/scripts", invalid_project + "/config"):
            sftp.mkdir(path, mode=0o700)
        sftp.put(str(PROJECT / "scripts/05-configure-server.sh"), invalid_project + "/scripts/05-configure-server.sh")
        invalid_template = json.loads((PROJECT / "config/server.template.json").read_text(encoding="utf-8"))
        invalid_template["outbounds"][0]["type"] = "invalid-test-outbound"
        write_json(invalid_project + "/config/server.template.json", invalid_template)
        stage("invalid candidate preserves configuration and credentials",
              prefix + "sh " + shlex.quote(invalid_project + "/scripts/05-configure-server.sh"), success=False)
        assert current_files == [read_bytes(state_dir + "/" + name) for name in ("config.json", "credentials.env")]
        assert sftp.listdir(state_dir + "/backups") == backups

        foreign_dir = remote + "/foreign-config"
        sftp.mkdir(foreign_dir, mode=0o700)
        write_json(foreign_dir + "/config.json", {"log": {"level": "warn"}})
        foreign_original = read_bytes(foreign_dir + "/config.json")
        stage("existing configuration without credentials is preserved",
              "SING_BOX=" + shlex.quote(core) + " CONFIG_DIR=" + shlex.quote(foreign_dir)
              + " sh " + shlex.quote(script), success=False)
        assert read_bytes(foreign_dir + "/config.json") == foreign_original
        assert sftp.listdir(foreign_dir) == ["config.json"]

        config = json.loads(read_bytes(state_dir + "/config.json"))
        for item in config["inbounds"]:
            item["listen"] = "127.0.0.1"
        server_path = remote + "/loopback-server.json"
        write_json(server_path, config)
        start(core, server_path, "server", [item["listen_port"] for item in config["inbounds"]])

        # 逐个协议验证两个并发 HTTPS 请求，使用同一套认证信息。
        for protocol, inbound in zip(("anytls", "vless"), config["inbounds"]):
            tls = {"enabled": True, "server_name": credentials["REALITY_SERVER"],
                   "utls": {"enabled": True, "fingerprint": "chrome"},
                   "reality": {"enabled": True, "public_key": credentials["REALITY_PUBLIC_KEY"],
                               "short_id": credentials["REALITY_SHORT_ID"]}}
            outbound = {"type": protocol, "tag": "proxy", "server": "127.0.0.1",
                        "server_port": inbound["listen_port"], "tls": tls}
            if protocol == "anytls":
                outbound["password"] = credentials["ANYTLS_PASSWORD"]
            else:
                outbound.update(uuid=credentials["VLESS_UUID"], flow="xtls-rprx-vision")
            client_config = {"log": {"level": "warn"},
                             "inbounds": [{"type": "mixed", "tag": "mixed", "listen": "127.0.0.1",
                                           "listen_port": ports[3]}],
                             "outbounds": [outbound], "route": {"final": "proxy"}}
            client_path = remote + "/" + protocol + "-client.json"
            write_json(client_path, client_config)
            pid = start(core, client_path, protocol + "-client", [ports[3]])
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: fetch_through_proxy(client, ports[3]), range(2)))
            report["stages"].append({"name": protocol + " shared credentials, 2 concurrent HTTPS requests",
                                     "exit_code": 0, "stdout": "\n".join(results), "stderr": ""})
            stop(pid)
            processes.remove(pid)
            # 客户端端口轮换，避免前一个进程退出时的监听状态影响下一轮。
            ports[3] = ports[4]
        after = stage("verify real configuration was not changed", footprint)
        assert before == after
        report["passed"] = True
        print("PASS: " + args.host + " dual-protocol generation and loopback HTTPS tests", flush=True)
    except Exception as error:
        report["error"] = type(error).__name__ + ": " + str(error)
        print("FAIL: " + report["error"], flush=True)
        if sftp:
            for label in ("server", "anytls-client", "vless-client"):
                try:
                    report["stages"].append({"name": label + " failure log",
                                             "stdout": read_bytes(remote + "/" + label + ".log").decode(errors="replace")[-4000:]})
                except OSError:
                    pass
    finally:
        password = None
        for pid in reversed(processes):
            try:
                stop(pid)
            except Exception as cleanup_error:
                report["passed"] = False
                report.setdefault("cleanup_errors", []).append(str(cleanup_error))
        if sftp:
            sftp.close()
        client.close()
        rendered = json.dumps(report, indent=2, ensure_ascii=False)
        for secret in secrets:
            rendered = rendered.replace(secret, "<redacted>")
        report_path.write_text(rendered, encoding="utf-8")
        print("REPORT: " + str(report_path), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
