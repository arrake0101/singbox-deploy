"""Offline download regression checks with small synthetic release archives.

No network or server access. Only the test copy uses fixture checksums and a
simulated platform; the real sha256sum, tar and filesystem operations still run.
"""

import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


PROJECT = Path(__file__).resolve().parents[1]
SHELL = shutil.which("sh")
if not SHELL:
    raise SystemExit("A local sh is required for this development test.")


def shell_path(path):
    """Represent Windows paths in the form understood by Git Bash."""
    path = Path(path).resolve()
    if os.name == "nt":
        return "/" + path.drive[0].lower() + path.as_posix()[2:]
    return str(path)


def write_shell(path, text):
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))
    path.chmod(0o755)


generated = PROJECT / "generated"
generated.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="download-test-", dir=generated) as temporary:
    workspace = Path(temporary).resolve()
    assert workspace.parent == generated.resolve()
    for directory in ("scripts", "lib", "bin", "archives"):
        (workspace / directory).mkdir()

    source = (PROJECT / "scripts/02-download-core.sh").read_text(encoding="utf-8")
    # Git Bash launchers can reset PATH. Set it inside the test copy as well so
    # curl always resolves to our fixture downloader, never a network client.
    source = source.replace('set -eu\n', 'set -eu\nPATH="$TEST_BIN:$PATH"\nexport PATH\n', 1)
    script = workspace / "scripts/02-download-core.sh"
    write_shell(script, source)
    platform = (PROJECT / "lib/platform.sh").read_text(encoding="utf-8")
    platform += '\nsb_detect_platform() { sb_platform_select "$TEST_OS" "$TEST_CPU"; }\n'
    write_shell(workspace / "lib/platform.sh", platform)
    write_shell(workspace / "bin/curl", '''#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) output=$2; shift 2 ;;
        *) url=$1; shift ;;
    esac
done
if [ "${TEST_DOWNLOAD_FAIL:-0}" = 1 ]; then exit 22; fi
cp "$TEST_ARCHIVES/${url##*/}" "$output"
if [ "${TEST_CORRUPT:-0}" = 1 ]; then printf 'corrupt archive' > "$output"; fi
''')

    environment = os.environ.copy()
    for name in ("TEST_DOWNLOAD_FAIL", "TEST_CORRUPT", "TEST_CORE_VERSION"):
        environment.pop(name, None)
    environment["PATH"] = str(workspace / "bin") + os.pathsep + environment["PATH"]
    environment["TEST_ARCHIVES"] = shell_path(workspace / "archives")
    environment["TEST_BIN"] = shell_path(workspace / "bin")
    environment["TEST_EXECUTION_LOG"] = shell_path(workspace / "executions.log")
    count = 0

    def run(os_id="debian", cpu="x86_64", root_name="core", preview=False, **options):
        env = environment.copy()
        env.update(TEST_OS=os_id, TEST_CPU=cpu, CORE_ROOT=shell_path(workspace / root_name))
        env.update(options)
        command = [SHELL, "scripts/02-download-core.sh"]
        if preview:
            command.append("--dry-run")
        return subprocess.run(command, cwd=workspace, env=env, capture_output=True, text=True, timeout=20)

    platforms = (
        ("debian", "x86_64", "amd64", "glibc"),
        ("debian", "aarch64", "arm64", "glibc"),
        ("alpine", "x86_64", "amd64", "musl"),
        ("alpine", "aarch64", "arm64", "musl"),
    )
    # Preview the unmodified production checksums and ensure no directory is made.
    for os_id, cpu, arch, libc in platforms:
        result = run(os_id, cpu, preview=True)
        assert result.returncode == 0, result.stdout + result.stderr
        assert f"ASSET=sing-box-1.14.3-linux-{arch}-{libc}.tar.gz" in result.stdout
        assert len(result.stdout.splitlines()) == 3, "Preview should only show three key fields"
        assert not (workspace / "core").exists()
        count += 1

    # The synthetic core records execution so a failed hash must leave no marker.
    binary = b'''#!/bin/sh
printf 'executed\n' >> "$TEST_EXECUTION_LOG"
printf 'sing-box version %s\n' "${TEST_CORE_VERSION:-1.14.3}"
'''
    official_hashes = re.findall(r"expected_sha256=([0-9a-f]{64})", source)
    assert len(official_hashes) == len(platforms)
    for index, (_, _, arch, libc) in enumerate(platforms):
        asset = f"sing-box-1.14.3-linux-{arch}-{libc}"
        archive = workspace / "archives" / (asset + ".tar.gz")
        with tarfile.open(archive, "w:gz") as output:
            entry = tarfile.TarInfo(asset + "/sing-box")
            entry.size = len(binary)
            entry.mode = 0o755
            output.addfile(entry, io.BytesIO(binary))
        fixture_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        source = source.replace(official_hashes[index], fixture_hash)
    write_shell(script, source)

    for os_id, cpu, arch, libc in platforms:
        result = run(os_id, cpu, root_name=f"core-{os_id}-{arch}")
        assert result.returncode == 0, result.stdout + result.stderr
        assert len(result.stdout.splitlines()) <= 3, "Default output should stay concise"
        assert "sing-box version 1.14.3" not in result.stdout
        installed = workspace / f"core-{os_id}-{arch}" / f"1.14.3-linux-{arch}-{libc}/sing-box"
        assert installed.read_bytes() == binary
        count += 1

    verbose_environment = environment.copy()
    verbose_environment.update(TEST_OS="debian", TEST_CPU="x86_64", CORE_ROOT=shell_path(workspace / "verbose-core"))
    result = subprocess.run([SHELL, "scripts/02-download-core.sh", "--verbose"],
                            cwd=workspace, env=verbose_environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "URL=" in result.stdout and "SHA256=" in result.stdout
    assert "sing-box version 1.14.3" in result.stdout
    count += 1

    installed = workspace / "core-debian-amd64/1.14.3-linux-amd64-glibc/sing-box"
    original_time = installed.stat().st_mtime_ns
    result = run(root_name="core-debian-amd64")
    assert result.returncode == 0, result.stdout + result.stderr
    assert installed.stat().st_mtime_ns == original_time
    count += 1

    marker = workspace / "executions.log"
    for failure in ("TEST_CORRUPT", "TEST_DOWNLOAD_FAIL"):
        marker.unlink(missing_ok=True)
        result = run(root_name=failure, **{failure: "1"})
        assert result.returncode != 0, "Failure was ignored"
        if failure == "TEST_CORRUPT":
            assert "FAILED" in result.stderr, "Checksum errors must remain visible"
        assert not marker.exists(), "Core executed after a download/hash failure"
        assert not list((workspace / failure).glob(".download.*")), "Staging files remain"
        assert not (workspace / failure / "1.14.3-linux-amd64-glibc").exists()
        count += 1

    result = run(root_name="wrong-version", TEST_CORE_VERSION="0.0.0")
    assert result.returncode != 0
    assert not (workspace / "wrong-version/1.14.3-linux-amd64-glibc").exists()
    count += 1

    existing = workspace / "preserved/1.14.3-linux-amd64-glibc/sing-box"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"keep existing file")
    result = run(root_name="preserved")
    assert result.returncode != 0
    assert existing.read_bytes() == b"keep existing file"
    count += 1

    print(f"PASS: {count} offline download checks (synthetic cores, no real Linux binary or network)")
