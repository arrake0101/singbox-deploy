#!/bin/sh
# 第三步：为第二步下载的核心建立固定入口和 sing-box 命令。
# 用法：sh scripts/03-install-core.sh [--dry-run] [--verbose]
# 自定义路径时，CORE_ROOT 必须与第二步相同，BIN_DIR 必须在 PATH 中。
set -eu

# 1. 安装位置。版本号与 02-download-core.sh 保持一致。
VERSION=1.14.3
CORE_ROOT=${CORE_ROOT:-/opt/singbox/core}
BIN_DIR=${BIN_DIR:-/usr/local/bin}

dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/03-install-core.sh [--dry-run] [--verbose]' >&2; exit 2 ;;
    esac
done
case "$CORE_ROOT" in
    /*) ;;
    *) printf '%s\n' 'CORE_ROOT must be an absolute path.' >&2; exit 2 ;;
esac
case "$BIN_DIR" in
    /*) ;;
    *) printf '%s\n' 'BIN_DIR must be an absolute path.' >&2; exit 2 ;;
esac

# 2. 找到当前系统对应的核心，检查下载步骤是否已经完成。
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$script_dir/../lib/platform.sh"
sb_detect_platform
if [ ! -d "$CORE_ROOT" ]; then
    printf '%s\n' 'Core directory is missing. Run 02-download-core.sh first.' >&2
    exit 1
fi
CORE_ROOT=$(CDPATH= cd -P "$CORE_ROOT" && pwd)
if [ -d "$BIN_DIR" ]; then
    BIN_DIR=$(CDPATH= cd -P "$BIN_DIR" && pwd)
fi
version_directory="$CORE_ROOT/$VERSION-linux-$SB_ARCH-$SB_LIBC"
core_path="$version_directory/sing-box"
current_link="$CORE_ROOT/current"
command_link="$BIN_DIR/sing-box"
command_target="$current_link/sing-box"

if [ ! -f "$core_path" ] || [ ! -x "$core_path" ]; then
    printf 'Core is missing or not executable: %s\n' "$core_path" >&2
    printf '%s\n' 'Run 02-download-core.sh first.' >&2
    exit 1
fi

# 3. 先检查两个入口，任何已有的不同文件、目录或链接都不覆盖。
# 只有目标完全一致的链接可以直接复用。
check_link() {
    if [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]; then
        return 0
    fi
    if [ -e "$1" ] || [ -L "$1" ]; then
        printf 'Existing path conflicts with this installation: %s\n' "$1" >&2
        return 1
    fi
}
check_link "$current_link" "$version_directory"
check_link "$command_link" "$command_target"

existing_command=$(command -v sing-box 2>/dev/null || true)
if [ -n "$existing_command" ] && [ "$existing_command" != "$command_link" ]; then
    printf 'Another sing-box command is already in PATH: %s\n' "$existing_command" >&2
    exit 1
fi

if [ "$dry_run" = true ] || [ "$verbose" = true ]; then
    printf 'CORE_PATH=%s\nCURRENT_LINK=%s\nCOMMAND_LINK=%s\n' "$core_path" "$current_link" "$command_link"
fi
if [ "$dry_run" = true ]; then
    exit 0
fi

# 4. 在修改入口之前运行核心，确认实际版本。
version_output=$("$core_path" version)
if ! printf '%s\n' "$version_output" | grep -Fxq "sing-box version $VERSION"; then
    printf '%s\n' "$version_output" >&2
    printf '%s\n' 'Core version does not match the expected version.' >&2
    exit 1
fi

# 5. 失败时只撤销本次创建的链接；已有的正确链接保持原样。
created_current=false
created_command=false
completed=false
rollback() {
    if [ "$completed" = true ]; then return; fi
    if [ "$created_command" = true ] && [ -L "$command_link" ] && [ "$(readlink "$command_link")" = "$command_target" ]; then
        rm -f "$command_link"
    fi
    if [ "$created_current" = true ] && [ -L "$current_link" ] && [ "$(readlink "$current_link")" = "$version_directory" ]; then
        rm -f "$current_link"
    fi
}
trap rollback 0
trap 'exit 1' 1 2 15

mkdir -p "$BIN_DIR"
if [ ! -L "$current_link" ]; then
    ln -s "$version_directory" "$current_link"
    created_current=true
fi
if [ ! -L "$command_link" ]; then
    ln -s "$command_target" "$command_link"
    created_command=true
fi

# 6. 验证用户直接输入 sing-box 时，会运行本次安装的核心。
hash -r 2>/dev/null || true
resolved_command=$(command -v sing-box 2>/dev/null || true)
if [ "$resolved_command" != "$command_link" ]; then
    printf 'Command directory is not selected by PATH: %s\n' "$BIN_DIR" >&2
    exit 1
fi
installed_output=$(sing-box version)
if ! printf '%s\n' "$installed_output" | grep -Fxq "sing-box version $VERSION"; then
    printf '%s\n' "$installed_output" >&2
    printf '%s\n' 'Installed command did not report the expected version.' >&2
    exit 1
fi

completed=true
if [ "$verbose" = true ]; then printf '%s\n' "$installed_output"; fi
printf 'PASS: sing-box %s installed at %s\n' "$VERSION" "$command_link"
