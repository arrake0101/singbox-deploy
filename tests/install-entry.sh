#!/bin/sh
# 一键入口的隔离回归：模拟步骤和包管理器，不安装软件或改真实服务。
set -eu
if [ "$(uname -s)" != Linux ]; then printf '%s\n' 'SKIP: installer regression checks require Linux'; exit 0; fi
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
mkdir -p "$project_dir/generated"
test_root=$(mktemp -d "$project_dir/generated/entry-test.XXXXXX")
checks=0

new_case() {
    case_dir="$test_root/$test_os-$1"
    mkdir -p "$case_dir/project/scripts" "$case_dir/project/lib" "$case_dir/project/config" "$case_dir/project/service" "$case_dir/bin"
    cp "$project_dir/install.sh" "$case_dir/project/install.sh"
    cp "$project_dir/lib/platform.sh" "$case_dir/project/lib/platform.sh"
    cat >> "$case_dir/project/lib/platform.sh" <<'PLATFORM'
sb_detect_platform() {
    sb_platform_select "$INSTALL_TEST_OS" x86_64
    SB_SERVICE_RUNTIME=$SB_SERVICE_DEFAULT
}
PLATFORM
    cp "$project_dir/service/"* "$case_dir/project/service/"
    cp "$project_dir/config/server.template.json" "$case_dir/project/config/"
    for tool in sh dirname id tar gzip sha256sum mktemp cmp grep awk sed tr readlink curl; do
        path=$(command -v "$tool" || true)
        if [ -n "$path" ]; then ln -s "$path" "$case_dir/bin/$tool"; fi
    done
    # 核心不会在这些入口测试中下载；只需让依赖探测看到 curl。
    if [ ! -e "$case_dir/bin/curl" ]; then ln -s "$(command -v true)" "$case_dir/bin/curl"; fi
    for number in 01 02 03 04 05 06; do
        case "$number" in
            01) filename=01-inspect.sh ;; 02) filename=02-download-core.sh ;;
            03) filename=03-install-core.sh ;; 04) filename=04-install-service.sh ;;
            05) filename=05-configure-server.sh ;; 06) filename=06-start-service.sh ;;
        esac
        printf '#!/bin/sh\nnumber=%s\n' "$number" > "$case_dir/project/scripts/$filename"
        cat >> "$case_dir/project/scripts/$filename" <<'STEP'
printf 'step=%s args=%s\n' "$number" "$*" >> "$INSTALL_TEST_LOG"
if [ "${INSTALL_TEST_FAIL:-}" = "$number" ]; then printf 'deliberate failure\n' >&2; exit 23; fi
printf 'output-%s\n' "$number"
if [ "$number" = 02 ]; then printf 'download-progress\n' >&2; fi
STEP
    done
    cat > "$case_dir/bin/package-manager" <<'MANAGER'
#!/bin/sh
printf 'package=%s args=%s\n' "${0##*/}" "$*" >> "$INSTALL_TEST_LOG"
if [ "${INSTALL_TEST_PACKAGE_FAIL:-0}" = 1 ]; then exit 17; fi
MANAGER
    chmod 0755 "$case_dir/bin/package-manager"
    ln -s package-manager "$case_dir/bin/apt-get"
    ln -s package-manager "$case_dir/bin/apk"
    : > "$case_dir/calls.log"
}
run_install() {
    PATH="$case_dir/bin" INSTALL_TEST_OS="$test_os" INSTALL_TEST_LOG="$case_dir/calls.log" \
        sh "$case_dir/project/install.sh" "$@" > "$case_dir/stdout" 2> "$case_dir/stderr"
}
passed() { checks=$((checks + 1)); }

for test_os in debian alpine; do
    new_case success
    run_install
    test "$(grep -c '^step=' "$case_dir/calls.log")" -eq 6
    test "$(sed -n 's/^step=\([0-9]*\).*/\1/p' "$case_dir/calls.log" | tr '\n' ' ')" = '01 02 03 04 05 06 '
    grep -q 'DONE:' "$case_dir/stdout"
    grep -q 'output-02' "$case_dir/stdout"
    grep -q 'output-06' "$case_dir/stdout"
    grep -q 'download-progress' "$case_dir/stderr"
    if grep -q 'output-05\|package=' "$case_dir/stdout" "$case_dir/calls.log"; then exit 1; fi
    passed

    new_case preview
    run_install --dry-run
    test ! -s "$case_dir/calls.log"
    grep -q 'Plan:' "$case_dir/stdout"
    passed

    new_case failure
    if INSTALL_TEST_FAIL=03 run_install; then exit 1; else result=$?; fi
    test "$result" -eq 23
    test "$(grep -c '^step=' "$case_dir/calls.log")" -eq 3
    grep -q 'FAIL: step 3' "$case_dir/stderr"
    if grep -q 'DONE:' "$case_dir/stdout"; then exit 1; fi
    passed

    new_case verbose
    run_install --verbose
    test "$(grep -c 'args=--verbose' "$case_dir/calls.log")" -eq 6
    grep -q 'output-05' "$case_dir/stdout"
    passed

    new_case bad-option
    if run_install --apply; then exit 1; fi
    test ! -s "$case_dir/calls.log"
    passed

    new_case bad-path
    if CORE_ROOT=/another/path run_install; then exit 1; fi
    test ! -s "$case_dir/calls.log"
    passed

    new_case incomplete-project
    mv "$case_dir/project/config/server.template.json" "$case_dir/template.saved"
    if run_install; then exit 1; fi
    test ! -s "$case_dir/calls.log"
    passed

    new_case missing-dependency
    mv "$case_dir/bin/curl" "$case_dir/curl.saved"
    run_install
    if [ "$test_os" = debian ]; then
        test "$(grep -c '^package=apt-get' "$case_dir/calls.log")" -eq 2
    else
        test "$(grep -c '^package=apk' "$case_dir/calls.log")" -eq 1
    fi
    test "$(grep -c '^step=' "$case_dir/calls.log")" -eq 6
    passed

    new_case dependency-failure
    mv "$case_dir/bin/curl" "$case_dir/curl.saved"
    if INSTALL_TEST_PACKAGE_FAIL=1 run_install; then exit 1; else result=$?; fi
    test "$result" -eq 17
    if grep -q '^step=' "$case_dir/calls.log"; then exit 1; fi
    passed
done
printf 'PASS: %s isolated installer checks\n' "$checks"
