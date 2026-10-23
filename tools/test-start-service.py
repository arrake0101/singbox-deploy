"""第六步实机验收：创建独立的临时服务，验证后移除，不改变正式服务和 NAT。"""

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
    remote = "/tmp/singbox-manual-start-test-" + run_id
    name = "singbox-test-" + run_id
    report = {"host": args.host, "remote_directory": remote, "temporary_service": name,
              "stages": [], "passed": False, "nat_changed": False}
    report_path = PROJECT / "generated/live-tests" / ("start-service-" + args.host + "-" + run_id + ".json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    service_created = False
    blocker_pid = None
    sftp = None
    manager = None
    service_file = None

    def stage(label, command, success=True):
        result = runner.execute(client, command, timeout=90)
        result["name"] = label
        report["stages"].append(result)
        if (result["exit_code"] == 0) != success:
            raise RuntimeError("Stage failed: " + label + "\n" + result["stderr"])
        return result["stdout"]

    def write(path, content, mode=0o600):
        with sftp.open(path, "w") as stream:
            stream.write(content)
        sftp.chmod(path, mode)

    def read(path):
        with sftp.open(path, "r") as stream:
            return stream.read().decode()

    def status_command():
        if manager == "systemd":
            return "systemctl is-active --quiet " + name + ".service"
        return "rc-service -q " + name + " status >/dev/null 2>&1"

    def pid_command():
        if manager == "systemd":
            return "systemctl show -p MainPID --value " + name + ".service"
        return "cat /run/" + name + ".pid"

    try:
        client.connect(args.host, port=args.port, username="root", password=password,
                       look_for_keys=False, allow_agent=False, timeout=15, auth_timeout=20)
        password = None
        sftp = client.open_sftp()
        sftp.mkdir(remote, mode=0o700)
        for directory in ("scripts", "lib", "service", "config", "data", "logs"):
            sftp.mkdir(remote + "/" + directory, mode=0o700)
        for relative in ("scripts/01-inspect.sh", "scripts/05-configure-server.sh", "lib/platform.sh",
                         "config/server.template.json"):
            sftp.put(str(PROJECT / relative), remote + "/" + relative)
        platform = stage("inspect native service manager", "sh " + remote + "/scripts/01-inspect.sh --summary")
        manager = dict(line.split("=", 1) for line in platform.splitlines())["ACTIVE_SERVICE_MANAGER"]
        if manager not in ("systemd", "openrc"):
            raise RuntimeError("No native service manager")
        report["service_manager"] = manager
        candidates = ["/usr/local/bin/sing-box"]
        for base in ("/opt/singbox/core", "/opt/singbox-manual/core"):
            for libc in ("glibc", "musl"):
                candidates.append(base + "/1.14.3-linux-amd64-" + libc + "/sing-box")
        for libc in ("glibc", "musl"):
            candidates.append("/var/backups/singbox-manual/reset-*/opt/singbox/core/1.14.3-linux-amd64-"
                              + libc + "/sing-box")
        core = stage("locate existing core", "for core in " + " ".join(candidates)
                     + '; do if [ -x "$core" ] && "$core" version 2>/dev/null | grep -Fxq "sing-box version 1.14.3"; '
                       'then printf "%s\\n" "$core"; exit 0; fi; done; exit 1').strip()
        footprint = '''set -eu
for file in /etc/sing-box/config.json /etc/sing-box/credentials.env /etc/init.d/sing-box /etc/systemd/system/sing-box.service; do
    if [ -f "$file" ]; then sha256sum "$file"; fi
done
if [ -d /run/openrc ]; then
    if rc-service -q sing-box status >/dev/null 2>&1; then printf 'active\\n'; else printf 'inactive\\n'; fi
    if [ -L /etc/runlevels/default/sing-box ]; then readlink /etc/runlevels/default/sing-box; fi
else
    systemctl is-active sing-box.service || true
    systemctl is-enabled sing-box.service || true
fi
'''
        before = stage("record formal service and configuration", footprint)
        occupied = configuration.listening_ports(sftp)
        ports = random.sample([p for p in range(30000, 59000) if p not in occupied], 3)
        config_path = remote + "/state/config.json"
        stage("generate isolated configuration", "SING_BOX=" + shlex.quote(core) + " CONFIG_DIR=" + remote
              + "/state ANYTLS_PORT=" + str(ports[0]) + " VLESS_PORT=" + str(ports[1])
              + " sh " + remote + "/scripts/05-configure-server.sh")
        original_config = read(config_path)

        # 仅在测试副本中替换固定路径和服务名称，执行相同的生产检查流程。
        replacements = {
            "/usr/local/bin/sing-box": core,
            "/etc/sing-box/config.json": config_path,
            "/var/lib/sing-box": remote + "/data",
            "/var/log/sing-box": remote + "/logs",
            "/run/sing-box.pid": "/run/" + name + ".pid",
            "/etc/init.d/sing-box": "/etc/init.d/" + name,
            "/etc/runlevels/default/sing-box": "/etc/runlevels/default/" + name,
            "sing-box.service": name + ".service",
            "rc-service sing-box": "rc-service " + name,
            "rc-service -q sing-box": "rc-service -q " + name,
        }

        def adapt(text):
            for old, new in replacements.items():
                text = text.replace(old, new)
            return text

        script = remote + "/scripts/06-start-service.sh"
        write(script, adapt((PROJECT / "scripts/06-start-service.sh").read_text(encoding="utf-8")))
        if manager == "systemd":
            service_file = "/etc/systemd/system/" + name + ".service"
            service_content = adapt((PROJECT / "service/sing-box.service").read_text(encoding="utf-8"))
            template = remote + "/service/" + name + ".service"
            enable = "systemctl daemon-reload\nsystemctl enable " + name + ".service"
            disable = "systemctl disable " + name + ".service"
            enable_again = "systemctl enable " + name + ".service"
            stop = "systemctl stop " + name + ".service"
        else:
            service_file = "/etc/init.d/" + name
            service_content = adapt((PROJECT / "service/sing-box.openrc").read_text(encoding="utf-8"))
            template = remote + "/service/sing-box.openrc"
            enable = "rc-update add " + name + " default"
            disable = "rc-update del " + name + " default"
            enable_again = enable
            stop = "rc-service " + name + " stop"
        stage("ensure unique temporary service name", "test ! -e " + service_file + " && test ! -L " + service_file)
        write(template, service_content)
        write(service_file, service_content, 0o755 if manager == "openrc" else 0o644)
        service_created = True
        stage("register temporary native service", "set -eu\n" + enable)
        command = "sh " + script
        stage("check detects stopped service", command + " --check", success=False)
        stage("preview leaves service stopped", "set -eu\n" + command + " --dry-run\nif "
              + status_command() + "; then exit 1; fi")
        stage("start and verify owned listeners", command)
        first_pid = stage("record service process", pid_command()).strip()
        stage("read-only check of running service", command + " --check")
        if stage("verify check preserves process", pid_command()).strip() != first_pid:
            raise RuntimeError("Read-only check restarted service")
        stage("repeat applies current configuration by restart", command)
        active_pid = stage("record restarted process", pid_command()).strip()
        if first_pid == active_pid or active_pid == "0":
            raise RuntimeError("Expected a new process after restart")
        if read(config_path) != original_config:
            raise RuntimeError("Start script rewrote configuration")

        # 无效配置必须在停止原服务前被拒绝。
        write(config_path, '{"invalid_test_field": true}')
        try:
            stage("invalid configuration preserves running service", command, success=False)
            if stage("verify original process survives invalid configuration", pid_command()).strip() != active_pid:
                raise RuntimeError("Invalid configuration interrupted running service")
        finally:
            write(config_path, original_config)

        # 相同核心、不同配置的进程占用端口，也必须被视为其他程序。
        blocker_config = remote + "/blocker.json"
        write(blocker_config, json.dumps({"inbounds": [{"type": "mixed", "listen": "0.0.0.0",
                                                       "listen_port": ports[2]}]}))
        blocker_pid = int(stage("launch conflicting listener", "trap '' HUP\n" + shlex.quote(core)
                                + " run -c " + blocker_config + " -D " + remote + "/data >" + remote
                                + "/blocker.log 2>&1 </dev/null &\nprintf '%s\\n' \"$!\"").strip())
        stage("wait for conflicting listener", "sleep 1; kill -0 " + str(blocker_pid))
        changed = json.loads(original_config)
        changed["inbounds"][0]["listen_port"] = ports[2]
        write(config_path, json.dumps(changed))
        try:
            stage("foreign occupied port preserves running service", command, success=False)
            if "already held by another process" not in report["stages"][-1]["stderr"]:
                raise RuntimeError("Expected a port conflict diagnostic")
            if stage("verify original process survives port conflict", pid_command()).strip() != active_pid:
                raise RuntimeError("Port conflict interrupted running service")
            stage("read-only check rejects foreign listener", command + " --check", success=False)
        finally:
            write(config_path, original_config)

        write(service_file, service_content + "\n# deliberately changed by isolated test\n",
              0o755 if manager == "openrc" else 0o644)
        try:
            stage("different service definition is rejected", command, success=False)
        finally:
            write(service_file, service_content, 0o755 if manager == "openrc" else 0o644)
        stage("temporarily disable test autostart", disable)
        stage("missing autostart is rejected", command, success=False)
        stage("restore test autostart", enable_again)
        stage("final running service check", command + " --check")
        stage("stop temporary service", stop)
        stage("stopped service is rejected", command + " --check", success=False)
        after = stage("verify formal deployment is unchanged", footprint)
        if before != after:
            raise RuntimeError("Formal deployment changed")
        report["passed"] = True
    except Exception as error:
        report["error"] = str(error)
        print("FAIL: " + str(error), flush=True)
    finally:
        if client.get_transport() and client.get_transport().is_active():
            if blocker_pid:
                result = runner.execute(client, "if [ -r /proc/" + str(blocker_pid)
                                        + "/cmdline ] && tr '\\000' ' ' < /proc/" + str(blocker_pid)
                                        + "/cmdline | grep -Fq " + remote + "; then kill " + str(blocker_pid) + "; fi")
                if result["exit_code"]:
                    report["cleanup_error"] = result["stderr"]
            if service_created:
                cleanup = "set -eu\n"
                if manager == "systemd":
                    cleanup += "systemctl stop " + name + ".service\nsystemctl disable " + name + ".service\n"
                else:
                    cleanup += "if " + status_command() + "; then rc-service " + name + " stop; fi\n"
                    cleanup += "rc-update del " + name + " default\n"
                cleanup += "rm -f " + service_file + "\n"
                if manager == "systemd":
                    cleanup += "systemctl daemon-reload\n"
                result = runner.execute(client, cleanup)
                report["cleanup"] = result
                if result["exit_code"]:
                    report["cleanup_error"] = result["stderr"]
        if report.get("cleanup_error"):
            report["passed"] = False
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
