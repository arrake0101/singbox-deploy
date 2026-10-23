#!/bin/sh
# 第六步：校验配置，启动服务，并确认两个 TCP 端口属于 sing-box。
# 已运行时会重启以应用当前配置；--check 只检查，--dry-run 只预览。
set -eu

# 1. 服务路径与第四步保持一致，不另外接受一套路径参数。
core=/usr/local/bin/sing-box
config=/etc/sing-box/config.json
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$script_dir/../lib/platform.sh"
dry_run=false
check_only=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --check) check_only=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/06-start-service.sh [--dry-run | --check] [--verbose]' >&2; exit 2 ;;
    esac
done
if [ "$dry_run" = true ] && [ "$check_only" = true ]; then
    printf '%s\n' 'Choose either --dry-run or --check.' >&2
    exit 2
fi
sb_detect_platform
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'Run this script as root.' >&2; exit 1; fi
if [ ! -x "$core" ]; then printf '%s\n' 'Run 03-install-core.sh first.' >&2; exit 1; fi
if [ -L "$config" ] || [ ! -f "$config" ]; then
    printf '%s\n' 'Expected a regular configuration file; run 05-configure-server.sh first.' >&2
    exit 1
fi

# 2. 只操作第四步注册的同一份服务，并确认已经开启自启。
case "$SB_SERVICE_RUNTIME" in
    systemd)
        service_file=/etc/systemd/system/sing-box.service
        template="$script_dir/../service/sing-box.service"
        loaded_file=$(systemctl show -p FragmentPath --value sing-box.service)
        if [ "$loaded_file" != "$service_file" ]; then
            printf '%s\n' 'Unexpected loaded service; run 04-install-service.sh or review it first.' >&2
            exit 1
        fi
        if ! systemctl is-enabled --quiet sing-box.service; then
            printf '%s\n' 'Autostart is not enabled; run 04-install-service.sh first.' >&2
            exit 1
        fi
        ;;
    openrc)
        service_file=/etc/init.d/sing-box
        template="$script_dir/../service/sing-box.openrc"
        if [ ! -L /etc/runlevels/default/sing-box ] ||
           [ "$(readlink -f /etc/runlevels/default/sing-box)" != "$service_file" ]; then
            printf '%s\n' 'Autostart is not enabled; run 04-install-service.sh first.' >&2
            exit 1
        fi
        ;;
    *) printf '%s\n' 'A running OpenRC or systemd instance is required.' >&2; exit 1 ;;
esac
if [ -L "$service_file" ] || [ ! -f "$service_file" ] || ! cmp -s "$template" "$service_file"; then
    printf 'Service definition differs; review it first: %s\n' "$service_file" >&2
    exit 1
fi
service_active() {
    if [ "$SB_SERVICE_RUNTIME" = systemd ]; then
        systemctl is-active --quiet sing-box.service
    else
        rc-service -q sing-box status >/dev/null 2>&1
    fi
}
show_log_command() {
    if [ "$SB_SERVICE_RUNTIME" = systemd ]; then
        printf '%s\n' 'Logs: journalctl -u sing-box.service -n 30 --no-pager' >&2
    else
        printf '%s\n' 'Logs: tail -n 30 /var/log/sing-box/stderr.log' >&2
    fi
}

# 3. 由核心检查 JSON，再读取核心格式化后的两个监听地址。
# format 不加 -w，只输出到内存，不重写配置；不依赖 jq 或 Python。
if ! check_output=$("$core" check -c "$config" 2>&1); then
    printf '%s\n' "$check_output" >&2
    exit 1
fi
formatted=$("$core" format -c "$config")
bindings=$(printf '%s\n' "$formatted" | awk '
    /^    \{/ { protocol=""; address=""; port="" }
    /^      "type":/ { protocol=$2; gsub(/[",]/, "", protocol) }
    /^      "listen":/ { address=$2; gsub(/[",]/, "", address) }
    /^      "listen_port":/ { port=$2; gsub(/,/, "", port) }
    /^    }/ {
        if (protocol == "anytls" || protocol == "vless") print protocol "=" address ":" port
    }
')
unset formatted
anytls_port=$(printf '%s\n' "$bindings" | sed -n 's/^anytls=0\.0\.0\.0://p')
vless_port=$(printf '%s\n' "$bindings" | sed -n 's/^vless=0\.0\.0\.0://p')
for port in "$anytls_port" "$vless_port"; do
    case "$port" in ''|0*|*[!0-9]*) printf '%s\n' 'Expected one AnyTLS and one VLESS inbound on 0.0.0.0; review step 05.' >&2; exit 1 ;; esac
    if [ "${#port}" -gt 5 ] || [ "$port" -gt 65535 ]; then printf '%s\n' 'Invalid listening port.' >&2; exit 1; fi
done
if [ "$anytls_port" = "$vless_port" ]; then printf '%s\n' 'The two protocols require different ports.' >&2; exit 1; fi
anytls_hex=$(printf '%04X' "$anytls_port")
vless_hex=$(printf '%04X' "$vless_port")
core_real=$(readlink -f "$core")
if [ ! -r /proc/net/tcp ]; then printf '%s\n' 'Readable Linux /proc is required for listener checks.' >&2; exit 1; fi

# 4. 检查监听套接字的归属，防止其他程序占用端口时误报成功。
# 只匹配同一个核心、同一个配置路径的进程；不扫描或输出认证信息。
core_sockets() {
        for process in /proc/[0-9]*; do
            [ "$(readlink "$process/exe" 2>/dev/null || true)" = "$core_real" ] || continue
            arguments=$(tr '\000' '\n' < "$process/cmdline" 2>/dev/null) || continue
            printf '%s\n' "$arguments" | grep -Fxq "$config" || continue
            for descriptor in "$process/fd/"*; do
                socket=$(readlink "$descriptor" 2>/dev/null || true)
                case "$socket" in
                    socket:\[*\]) inode=${socket#socket:\[}; printf '%s\n' "${inode%\]}" ;;
                esac
            done
        done
}
ports_ready() {
    owned_sockets=$(core_sockets)
    [ -n "$owned_sockets" ] || return 1
    awk -v sockets="$owned_sockets" -v a="$anytls_hex" -v v="$vless_hex" '
        BEGIN { count=split(sockets, list, "\n"); for (i=1; i<=count; i++) owned[list[i]]=1 }
        $4 == "0A" && owned[$10] {
            split($2, local_address, ":")
            if (local_address[1] == "00000000") {
                if (local_address[2] == a) anytls=1
                if (local_address[2] == v) vless=1
            }
        }
        END { exit !(anytls && vless) }
    ' /proc/net/tcp
}

action=start
if service_active; then action=restart; fi
if [ "$dry_run" = true ] || [ "$verbose" = true ]; then
    printf 'SERVICE_MANAGER=%s\nCONFIG_PATH=%s\nACTION=%s\nANYTLS_TCP=%s\nVLESS_TCP=%s\n' \
        "$SB_SERVICE_RUNTIME" "$config" "$action" "$anytls_port" "$vless_port"
fi
if [ "$dry_run" = true ]; then exit 0; fi

# 5. 预检通过后才启动或重启。--check 全程不改变服务状态。
if [ "$check_only" = false ]; then
    # 停止已有服务之前检查冲突，其他程序持有目标端口时保留原服务。
    allowed_sockets=
    if [ "$action" = restart ]; then allowed_sockets=$(core_sockets); fi
    set -- /proc/net/tcp
    if [ -r /proc/net/tcp6 ]; then set -- "$@" /proc/net/tcp6; fi
    if ! awk -v sockets="$allowed_sockets" -v a="$anytls_hex" -v v="$vless_hex" '
        BEGIN { count=split(sockets, list, "\n"); for (i=1; i<=count; i++) owned[list[i]]=1 }
        $4 == "0A" {
            split($2, local_address, ":")
            if ((local_address[2] == a || local_address[2] == v) && !owned[$10]) conflict=1
        }
        END { exit conflict }
    ' "$@"; then
        printf '%s\n' 'A target TCP port is already held by another process; service was not changed.' >&2
        exit 1
    fi
    if [ "$SB_SERVICE_RUNTIME" = systemd ]; then
        if ! manager_output=$(systemctl "$action" sing-box.service 2>&1); then
            printf '%s\n' "$manager_output" >&2; show_log_command; exit 1
        fi
    else
        if ! manager_output=$(rc-service sing-box "$action" 2>&1); then
            printf '%s\n' "$manager_output" >&2; show_log_command; exit 1
        fi
    fi
    if [ "$verbose" = true ] && [ -n "$manager_output" ]; then printf '%s\n' "$manager_output"; fi
fi

# 最多等待十秒；再隔一秒复查，避免刚启动就退出时误报通过。
attempt=0
while [ "$attempt" -lt 10 ]; do
    if service_active && ports_ready; then
        sleep 1
        if service_active && ports_ready; then
            printf 'PASS: sing-box running; autostart enabled; AnyTLS TCP %s; VLESS TCP %s\n' "$anytls_port" "$vless_port"
            printf 'NAT (if needed): public TCP ports -> server TCP %s / %s\n' "$anytls_port" "$vless_port"
            exit 0
        fi
    fi
    if [ "$check_only" = true ]; then break; fi
    sleep 1
    attempt=$((attempt + 1))
done
printf '%s\n' 'FAIL: service is not running with both expected TCP listeners owned by sing-box.' >&2
show_log_command
exit 1
