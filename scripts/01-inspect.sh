#!/bin/sh
# 第一步：检查服务器环境，只读取信息。
# 默认只显示一行结果；--verbose 查看详细信息，--summary 保留机器可读字段。
set -eu

inspect_script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
# 唯一的公共依赖：Debian / Alpine 的环境判断，后续安装脚本也会使用。
. "$inspect_script_dir/../lib/platform.sh"

if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: sh scripts/01-inspect.sh [--verbose|--summary]' >&2
    exit 2
fi
case "${1:-}" in
    ''|--verbose|--summary) ;;
    *) printf '%s\n' 'Usage: sh scripts/01-inspect.sh [--verbose|--summary]' >&2; exit 2 ;;
esac

# 1. 确认系统在支持范围内，输出环境摘要。
sb_detect_platform
if [ "${1:-}" = --summary ]; then
    sb_print_platform
    exit 0
fi
if [ "${1:-}" != --verbose ]; then
    printf 'PASS: OS=%s ARCH=%s SERVICE=%s\n' "$SB_OS_ID" "$SB_ARCH" "$SB_SERVICE_RUNTIME"
    exit 0
fi
sb_print_platform

section() {
    printf '\n%s\n' "=== $1 ==="
}

# 2. 显示系统版本和内核信息。
section 'Operating system'
if [ -r /etc/os-release ]; then
    cat /etc/os-release
else
    printf '%s\n' '/etc/os-release is unavailable'
fi

section 'Kernel and CPU architecture'
uname -srm

# 3. 查看实际运行库信息，与摘要中的 EXPECTED_LIBC 对照。
section 'C library (use this output to confirm musl or glibc)'
if command -v ldd >/dev/null 2>&1; then
    # 部分 musl 的 ldd --version 返回非零，这不影响继续显示其他信息。
    ldd --version 2>&1 || true
else
    printf '%s\n' 'ldd is unavailable; C library needs further inspection'
fi

# 4. 查看系统现有工具；这里只列出命令，不执行安装和服务操作。
section 'Available service management commands'
for inspect_tool in rc-service rc-update systemctl supervisorctl; do
    if command -v "$inspect_tool" >/dev/null 2>&1; then
        command -v "$inspect_tool"
    fi
done
printf '%s\n' 'Command presence alone does not confirm a running service manager.'

section 'Available installation and download tools'
for inspect_tool in apk apt-get curl wget tar sha256sum openssl; do
    if command -v "$inspect_tool" >/dev/null 2>&1; then
        command -v "$inspect_tool"
    fi
done

# 5. 查看内存和执行用户。
section 'Memory'
if [ -r /proc/meminfo ] && command -v awk >/dev/null 2>&1; then
    awk '/^(MemTotal|MemAvailable|SwapTotal):/ { print }' /proc/meminfo
else
    printf '%s\n' 'Memory information is unavailable'
fi

section 'Current user'
id

# 6. 查看 PATH 中是否已经存在 sing-box，不覆盖已有安装。
section 'sing-box found in PATH'
if command -v sing-box >/dev/null 2>&1; then
    command -v sing-box
    sing-box version || true
else
    printf '%s\n' 'Not found in PATH; a custom installation may still exist.'
fi

printf '\n%s\n' 'Inspection complete. Share this output before selecting an installation asset.'
