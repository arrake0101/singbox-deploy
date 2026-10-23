#!/bin/sh
# 一键安装入口：检查环境和依赖，再按顺序执行 01～06。
# 保留分步脚本，安装逻辑只维护一份；不会调用 00 清理环境。
set -eu

project_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        --help|-h)
            printf '%s\n' 'Usage: sh install.sh [--dry-run] [--verbose]' \
                'Optional: ANYTLS_PORT, VLESS_PORT, REALITY_SERVER.' \
                'Existing credentials are reused. A running service will be restarted.'
            exit 0
            ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
    esac
done

# 1. 在任何安装动作之前检查上传文件、路径和当前系统。
for file in lib/platform.sh scripts/01-inspect.sh scripts/02-download-core.sh \
    scripts/03-install-core.sh scripts/04-install-service.sh \
    scripts/05-configure-server.sh scripts/06-start-service.sh \
    service/sing-box.openrc service/sing-box.service config/server.template.json; do
    if [ ! -f "$project_dir/$file" ]; then
        printf 'Missing project file: %s\nUpload the complete project directory first.\n' "$file" >&2
        exit 1
    fi
done
for file in "$project_dir/install.sh" "$project_dir/lib/platform.sh" "$project_dir/scripts/"*.sh; do
    sh -n "$file"
done
. "$project_dir/lib/platform.sh"
sb_detect_platform
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'Run this installer as root.' >&2; exit 1; fi
case "$SB_SERVICE_RUNTIME" in
    systemd|openrc) ;;
    *) printf '%s\n' 'A running OpenRC or systemd instance is required.' >&2; exit 1 ;;
esac

# 服务模板和清理脚本使用固定位置，一键入口不允许混用自定义安装路径。
if [ "${CORE_ROOT:-/opt/singbox/core}" != /opt/singbox/core ] ||
   [ "${BIN_DIR:-/usr/local/bin}" != /usr/local/bin ] ||
   [ "${SING_BOX:-/usr/local/bin/sing-box}" != /usr/local/bin/sing-box ] ||
   [ "${CONFIG_DIR:-/etc/sing-box}" != /etc/sing-box ]; then
    printf '%s\n' 'The one-click installer uses the standard paths; unset CORE_ROOT, BIN_DIR, SING_BOX and CONFIG_DIR.' >&2
    exit 2
fi

# 2. 只在缺少工具或 CA 证书包时安装依赖，不升级系统或安装另一套核心。
missing=
for tool in curl tar gzip sha256sum mktemp cmp grep awk sed tr readlink; do
    if ! command -v "$tool" >/dev/null 2>&1; then missing="$missing $tool"; fi
done
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then missing="$missing ca-certificates"; fi
if [ "$dry_run" = true ]; then
    printf 'OS=%s ARCH=%s SERVICE=%s\n' "$SB_OS_ID" "$SB_ARCH" "$SB_SERVICE_RUNTIME"
    if [ -n "$missing" ]; then printf 'Install missing dependencies:%s\n' "$missing"; fi
    printf '%s\n' 'Plan: 01 inspect -> 02 download -> 03 install core -> 04 enable service -> 05 configure -> 06 start/check' \
        'Paths: /opt/singbox/core; /usr/local/bin/sing-box; /etc/sing-box' \
        'Existing credentials will be reused; a running service will be restarted.'
    exit 0
fi
if [ -n "$missing" ]; then
    printf 'Installing missing dependencies:%s\n' "$missing"
    case "$SB_OS_ID" in
        debian)
            apt-get update
            DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tar gzip coreutils
            ;;
        alpine)
            apk add --no-cache ca-certificates curl tar gzip coreutils
            ;;
    esac
fi

# 3. 每步只显示进度；失败立即停止，保留已完成部分供修复后重试。
# 下载和最终检查直接显示输出，其他步骤默认收起成功信息。
run_step() {
    number=$1
    label=$2
    filename=$3
    printf '[%s/6] %s\n' "$number" "$label"
    set --
    if [ "$verbose" = true ]; then set -- --verbose; fi
    case "$number-$verbose" in
        2-*|6-*|*-true)
            if sh "$project_dir/scripts/$filename" "$@"; then return; else result=$?; fi
            ;;
        *)
            if step_output=$(sh "$project_dir/scripts/$filename" "$@"); then return; else result=$?; fi
            if [ -n "$step_output" ]; then printf '%s\n' "$step_output" >&2; fi
            ;;
    esac
    printf 'FAIL: step %s (%s). Fix the error and rerun sh install.sh.\n' "$number" "$filename" >&2
    exit "$result"
}
run_step 1 'Inspect environment' 01-inspect.sh
run_step 2 'Download and verify core' 02-download-core.sh
run_step 3 'Install core command' 03-install-core.sh
run_step 4 'Register service and enable autostart' 04-install-service.sh
run_step 5 'Generate and validate configuration' 05-configure-server.sh
run_step 6 'Start service and check listeners' 06-start-service.sh

printf '%s\n' 'DONE: server installation complete. Config: /etc/sing-box/config.json'
