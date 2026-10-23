#!/bin/sh
# 快速验证入口：检查语法 → 检查系统分支 → 执行第一步环境检查。
# 此脚本不会安装核心或修改服务。
set -eu
check_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)

if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: sh check.sh [--offline]' >&2
    exit 2
fi
case "${1:-}" in
    ''|--offline) ;;
    *) printf '%s\n' 'Usage: sh check.sh [--offline]' >&2; exit 2 ;;
esac

# 目录结构保持简单，每个目录中的 Shell 脚本都列入语法检查。
for check_file in "$check_dir/install.sh" "$check_dir/check.sh" "$check_dir/scripts/"*.sh "$check_dir/lib/"*.sh "$check_dir/tests/"*.sh; do
    sh -n "$check_file"
done
sh -n "$check_dir/service/sing-box.openrc"

if ! sh "$check_dir/tests/platform.sh" >/dev/null; then
    printf '%s\n' 'FAIL: platform checks' >&2
    exit 1
fi

if [ "${1:-}" = --offline ]; then
    printf '%s\n' 'PASS: offline checks'
    exit 0
fi

# 默认只显示环境摘要；详细信息可单独执行 01-inspect.sh --verbose。
sh "$check_dir/scripts/01-inspect.sh"
printf '%s\n' 'PASS: current-stage checks'
