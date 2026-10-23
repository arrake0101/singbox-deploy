#!/bin/sh
# 第四步：注册后台服务，设置开机自启；配置完成后再单独启动。
# 用法：sh scripts/04-install-service.sh [--dry-run] [--verbose]
set -eu

# 1. 服务统一使用第三步安装的命令，配置文件在下一步生成。
core=/usr/local/bin/sing-box
config=/etc/sing-box/config.json
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$script_dir/../lib/platform.sh"

dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/04-install-service.sh [--dry-run] [--verbose]' >&2; exit 2 ;;
    esac
done
sb_detect_platform
if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this service installer as root.' >&2
    exit 1
fi
if [ ! -x "$core" ]; then
    printf '%s\n' 'Run 03-install-core.sh first.' >&2
    exit 1
fi

# 2. 选择正在运行的服务管理工具，不只根据发行版名称推断。
case "$SB_SERVICE_RUNTIME" in
    openrc)
        service_file=/etc/init.d/sing-box
        source_file="$script_dir/../service/sing-box.openrc"
        file_mode=0755
        for tool in rc-service rc-update supervise-daemon; do
            if ! command -v "$tool" >/dev/null 2>&1; then
                printf 'Missing required tool: %s\n' "$tool" >&2
                exit 1
            fi
        done
        ;;
    systemd)
        service_file=/etc/systemd/system/sing-box.service
        source_file="$script_dir/../service/sing-box.service"
        file_mode=0644
        loaded_file=$(systemctl show -p FragmentPath --value sing-box.service 2>/dev/null || true)
        if [ -n "$loaded_file" ] && [ "$loaded_file" != "$service_file" ]; then
            printf 'Another sing-box service is already installed: %s\n' "$loaded_file" >&2
            exit 1
        fi
        ;;
    *)
        printf '%s\n' 'A running OpenRC or systemd instance is required.' >&2
        exit 1
        ;;
esac

# 3. 保留已有服务：只有内容完全相同的普通文件可以复用。
if [ ! -f "$source_file" ]; then
    printf 'Service template is missing: %s\n' "$source_file" >&2
    exit 1
fi
if [ -e "$service_file" ] || [ -L "$service_file" ]; then
    if [ -L "$service_file" ] || [ ! -f "$service_file" ] || ! cmp -s "$source_file" "$service_file"; then
        printf 'Existing service differs; review it first: %s\n' "$service_file" >&2
        exit 1
    fi
fi

if [ "$dry_run" = true ] || [ "$verbose" = true ]; then
    printf 'SERVICE_MANAGER=%s\nSERVICE_FILE=%s\nCONFIG_PATH=%s\n' "$SB_SERVICE_RUNTIME" "$service_file" "$config"
fi
if [ "$dry_run" = true ]; then exit 0; fi

# 4. 准备目录，但不创建或修改协议配置。
for directory in /etc/sing-box /var/lib/sing-box /var/log/sing-box; do
    if [ ! -d "$directory" ]; then
        mkdir -m 0750 "$directory"
    fi
done
if [ ! -e "$service_file" ]; then
    cp "$source_file" "$service_file"
    chmod "$file_mode" "$service_file"
fi

# 5. 只启用开机自启，不使用 --now，也不在安装时启动或重启服务。
if [ "$SB_SERVICE_RUNTIME" = openrc ]; then
    sh -n "$service_file"
    if ! enable_output=$(rc-update add sing-box default 2>&1); then
        printf '%s\n' "$enable_output" >&2
        exit 1
    fi
    test -L /etc/runlevels/default/sing-box
else
    systemctl daemon-reload
    if ! enable_output=$(systemctl enable sing-box.service 2>&1); then
        printf '%s\n' "$enable_output" >&2
        exit 1
    fi
    systemctl is-enabled --quiet sing-box.service
fi
if [ "$verbose" = true ]; then printf '%s\n' "$enable_output"; fi

printf 'PASS: sing-box service installed; autostart enabled (%s)\n' "$SB_SERVICE_RUNTIME"
if [ ! -f "$config" ]; then
    printf 'Pending: create %s before starting the service.\n' "$config"
fi
