#!/bin/sh
# Linux 上的隔离回归检查：模拟核心，只在 generated/ 中建立入口。
# 不下载文件，不修改 /usr/local/bin，也不执行后台服务。
set -eu
if [ "$(uname -s)" != Linux ]; then
    printf '%s\n' 'SKIP: install regression checks require Linux symlinks'
    exit 0
fi
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
. "$project_dir/lib/platform.sh"
sb_detect_platform
mkdir -p "$project_dir/generated"
test_root=$(mktemp -d "$project_dir/generated/install-test.XXXXXX")
tools_dir="$test_root/tools"
mkdir "$tools_dir"

# 隔离 PATH，避免测试与服务器上已有的 sing-box 命令互相影响。
for tool in sh dirname uname sed tr grep readlink ln mkdir rm; do
    ln -s "$(command -v "$tool")" "$tools_dir/$tool"
done

new_case() {
    case_dir="$test_root/$1"
    core_root="$case_dir/core"
    bin_dir="$case_dir/bin"
    version_dir="$core_root/1.14.3-linux-$SB_ARCH-$SB_LIBC"
    current="$core_root/current"
    command_link="$bin_dir/sing-box"
    mkdir -p "$version_dir" "$bin_dir"
    cat > "$version_dir/sing-box" <<'TEST_CORE'
#!/bin/sh
case "$0" in
    */bin/sing-box)
        if [ "${TEST_FAIL_FIXED:-0}" = 1 ]; then
            printf '%s\n' 'sing-box version 0.0.0'
            exit 0
        fi
        ;;
esac
printf 'sing-box version %s\n' "${TEST_CORE_VERSION:-1.14.3}"
TEST_CORE
    chmod 0755 "$version_dir/sing-box"
}

run_install() {
    PATH="$bin_dir:$tools_dir" CORE_ROOT="$core_root" BIN_DIR="$bin_dir" \
        sh "$project_dir/scripts/03-install-core.sh" "$@" > "$case_dir/result.log" 2>&1
}
expect_success() {
    if ! run_install "$@"; then cat "$case_dir/result.log" >&2; exit 1; fi
}
expect_failure() {
    if run_install "$@"; then
        printf 'FAIL: expected rejection in %s\n' "$case_dir" >&2
        exit 1
    fi
}

# 1. 预览不创建入口。
new_case preview
expect_success --dry-run
[ ! -e "$current" ] && [ ! -L "$current" ]
[ ! -e "$command_link" ] && [ ! -L "$command_link" ]

# 2. 正常安装建立两个真实链接，默认只输出一行结果。
new_case install
expect_success
[ "$(readlink "$current")" = "$version_dir" ]
[ "$(readlink "$command_link")" = "$current/sing-box" ]
[ "$(wc -l < "$case_dir/result.log")" -eq 1 ]

# 3. 重复执行保持原链接的 inode 和修改时间。
before=$(stat -c '%i:%Y' "$current" "$command_link")
expect_success
[ "$before" = "$(stat -c '%i:%Y' "$current" "$command_link")" ]

# 4. 普通命令文件冲突时，两个入口都不修改。
new_case command-conflict
printf '%s\n' 'keep existing file' > "$command_link"
expect_failure
[ "$(cat "$command_link")" = 'keep existing file' ]
[ ! -L "$current" ]

# 5. 固定入口为已有目录时，保留目录和其中的文件。
new_case current-conflict
mkdir "$current"
printf '%s\n' 'keep' > "$current/marker"
expect_failure
[ "$(cat "$current/marker")" = keep ]
[ ! -L "$command_link" ]

# 6. 版本不匹配时，不创建入口。
new_case wrong-version
TEST_CORE_VERSION=0.0.0 expect_failure
[ ! -L "$current" ] && [ ! -L "$command_link" ]

# 7. PATH 中存在其他安装时，不用新的入口遮住它。
new_case path-conflict
ln -s "$version_dir/sing-box" "$tools_dir/sing-box"
expect_failure
[ ! -L "$current" ] && [ ! -L "$command_link" ]
rm -f "$tools_dir/sing-box"

# 8. 固定命令验证失败时，撤销本次创建的两个链接。
new_case rollback
TEST_FAIL_FIXED=1 expect_failure
[ ! -L "$current" ] && [ ! -L "$command_link" ]

# 9. 失败回滚只撤销新链接，已有正确链接继续保留。
new_case partial-rollback
ln -s "$version_dir" "$current"
TEST_FAIL_FIXED=1 expect_failure
[ "$(readlink "$current")" = "$version_dir" ]
[ ! -L "$command_link" ]

# 10. 核心缺失时，明确拒绝安装。
new_case missing-core
rm -f "$version_dir/sing-box"
expect_failure
[ ! -L "$current" ] && [ ! -L "$command_link" ]

printf '%s\n' 'PASS: 10 isolated install checks'
