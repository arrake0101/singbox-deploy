#!/bin/sh
# 第五步：生成双协议配置，复用认证信息，通过检查后再保存。
# 默认不启动或重启服务，不配置公网 NAT。
# 用法：sh scripts/05-configure-server.sh [--dry-run] [--verbose]
set -eu
umask 077

# 1. 默认路径；端口和握手目标可通过同名环境变量明确调整。
SING_BOX=${SING_BOX:-/usr/local/bin/sing-box}
CONFIG_DIR=${CONFIG_DIR:-/etc/sing-box}
ANYTLS_PORT=${ANYTLS_PORT:-}
VLESS_PORT=${VLESS_PORT:-}
REALITY_SERVER=${REALITY_SERVER:-}
dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/05-configure-server.sh [--dry-run] [--verbose]' >&2; exit 2 ;;
    esac
done
case "$CONFIG_DIR" in /*) ;; *) printf '%s\n' 'CONFIG_DIR must be an absolute path.' >&2; exit 2 ;; esac
case "$SING_BOX" in /*) ;; *) printf '%s\n' 'SING_BOX must be an absolute path.' >&2; exit 2 ;; esac
if [ "$(id -u)" -ne 0 ]; then printf '%s\n' 'Run this configuration script as root.' >&2; exit 1; fi
if [ ! -x "$SING_BOX" ]; then printf '%s\n' 'Run 02-download-core.sh and 03-install-core.sh first.' >&2; exit 1; fi
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
template="$script_dir/../config/server.template.json"
config_file="$CONFIG_DIR/config.json"
state_file="$CONFIG_DIR/credentials.env"

# 2. 读取旧参数，但不把凭据文件作为 Shell 代码执行。
for path in "$CONFIG_DIR" "$config_file" "$state_file"; do
    if [ -L "$path" ]; then printf 'Refusing a symbolic link: %s\n' "$path" >&2; exit 1; fi
done
for path in "$config_file" "$state_file"; do
    if [ -e "$path" ] && [ ! -f "$path" ]; then printf 'Expected a regular file: %s\n' "$path" >&2; exit 1; fi
done
saved_value() {
    sed -n "s/^$1=//p" "$state_file"
}
if [ -f "$state_file" ]; then
    if [ "$(saved_value FORMAT)" != singbox-manual-v1 ]; then
        printf '%s\n' 'Credentials file does not belong to this configuration format.' >&2
        exit 1
    fi
    ANYTLS_PORT=${ANYTLS_PORT:-$(saved_value ANYTLS_PORT)}
    VLESS_PORT=${VLESS_PORT:-$(saved_value VLESS_PORT)}
    REALITY_SERVER=${REALITY_SERVER:-$(saved_value REALITY_SERVER)}
elif [ -e "$config_file" ]; then
    printf '%s\n' 'Existing configuration has no matching credentials file; nothing was changed.' >&2
    exit 1
fi
ANYTLS_PORT=${ANYTLS_PORT:-10443}
VLESS_PORT=${VLESS_PORT:-11443}
REALITY_SERVER=${REALITY_SERVER:-www.apple.com}

# 所有替换值都限制为简单字符，避免 JSON 转义和 Shell 注入问题。
for port in "$ANYTLS_PORT" "$VLESS_PORT"; do
    case "$port" in ''|0*|*[!0-9]*) printf '%s\n' 'Ports must be integers from 1 to 65535, without leading zeros.' >&2; exit 1 ;; esac
    if [ "${#port}" -gt 5 ] || [ "$port" -gt 65535 ]; then printf '%s\n' 'Port is out of range.' >&2; exit 1; fi
done
if [ "$ANYTLS_PORT" = "$VLESS_PORT" ]; then printf '%s\n' 'The two protocols require different ports.' >&2; exit 1; fi
case "$REALITY_SERVER" in ''|*[!A-Za-z0-9.-]*|[-.]*|*[-.]) printf '%s\n' 'Invalid REALITY handshake hostname.' >&2; exit 1 ;; esac
if [ "$dry_run" = true ] || [ "$verbose" = true ]; then
    printf 'CONFIG_PATH=%s\nANYTLS_PORT=%s\nVLESS_PORT=%s\nREALITY_SERVER=%s\n' "$config_file" "$ANYTLS_PORT" "$VLESS_PORT" "$REALITY_SERVER"
fi
if [ "$dry_run" = true ]; then exit 0; fi
if [ ! -f "$template" ]; then printf '%s\n' 'Configuration template is missing.' >&2; exit 1; fi
if ! "$SING_BOX" version | grep -Fxq 'sing-box version 1.14.3'; then
    printf '%s\n' 'This template requires sing-box 1.14.3.' >&2
    exit 1
fi

# 3. 暂存文件和锁都放在配置目录中，避免并发执行互相覆盖。
mkdir -p "$CONFIG_DIR"
lock_dir="$CONFIG_DIR/.configure.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then printf '%s\n' 'Configuration is locked by another run; inspect .configure.lock first.' >&2; exit 1; fi
work_dir=$lock_dir
cleanup() {
    rm -f "$work_dir/config.json" "$work_dir/credentials.env"
    rmdir "$work_dir"
}
trap cleanup 0
trap 'exit 1' 1 2 15

# 4. 初次执行生成身份；后续读取原身份，所有设备继续共用。
if [ -f "$state_file" ]; then
    anytls_password=$(saved_value ANYTLS_PASSWORD)
    vless_uuid=$(saved_value VLESS_UUID)
    reality_private_key=$(saved_value REALITY_PRIVATE_KEY)
    reality_public_key=$(saved_value REALITY_PUBLIC_KEY)
    reality_short_id=$(saved_value REALITY_SHORT_ID)
else
    anytls_password=$("$SING_BOX" generate rand --hex 32)
    vless_uuid=$("$SING_BOX" generate uuid)
    keypair=$("$SING_BOX" generate reality-keypair)
    reality_private_key=$(printf '%s\n' "$keypair" | sed -n 's/^PrivateKey: *//p')
    reality_public_key=$(printf '%s\n' "$keypair" | sed -n 's/^PublicKey: *//p')
    reality_short_id=$("$SING_BOX" generate rand --hex 8)
fi
for value in "$anytls_password" "$vless_uuid" "$reality_private_key" "$reality_public_key" "$reality_short_id"; do
    case "$value" in ''|*[!A-Za-z0-9_-]*) printf '%s\n' 'Invalid credential format; nothing was changed.' >&2; exit 1 ;; esac
done
if [ "${#anytls_password}" -ne 64 ] || [ "${#vless_uuid}" -ne 36 ] || \
   [ "${#reality_private_key}" -ne 43 ] || [ "${#reality_public_key}" -ne 43 ] || [ "${#reality_short_id}" -ne 16 ]; then
    printf '%s\n' 'Credential length check failed; nothing was changed.' >&2
    exit 1
fi

# 5. 模板只负责 JSON 结构；秘密值不会输出到终端。
sed -e "s|\"@@ANYTLS_PORT@@\"|$ANYTLS_PORT|g" \
    -e "s|\"@@VLESS_PORT@@\"|$VLESS_PORT|g" \
    -e "s|@@ANYTLS_PASSWORD@@|$anytls_password|g" \
    -e "s|@@VLESS_UUID@@|$vless_uuid|g" \
    -e "s|@@REALITY_SERVER@@|$REALITY_SERVER|g" \
    -e "s|@@REALITY_PRIVATE_KEY@@|$reality_private_key|g" \
    -e "s|@@REALITY_SHORT_ID@@|$reality_short_id|g" \
    "$template" > "$work_dir/config.json"
cat > "$work_dir/credentials.env" <<EOF
FORMAT=singbox-manual-v1
ANYTLS_PORT=$ANYTLS_PORT
VLESS_PORT=$VLESS_PORT
REALITY_SERVER=$REALITY_SERVER
ANYTLS_PASSWORD=$anytls_password
VLESS_UUID=$vless_uuid
REALITY_PRIVATE_KEY=$reality_private_key
REALITY_PUBLIC_KEY=$reality_public_key
REALITY_SHORT_ID=$reality_short_id
EOF
if ! check_output=$("$SING_BOX" check -c "$work_dir/config.json" 2>&1); then
    printf '%s\n' "$check_output" >&2
    exit 1
fi
if [ -f "$config_file" ] && cmp -s "$work_dir/config.json" "$config_file" && cmp -s "$work_dir/credentials.env" "$state_file"; then
    chmod 0600 "$config_file" "$state_file"
    printf 'PASS: configuration valid and unchanged (%s)\n' "$config_file"
    exit 0
fi

# 6. 校验通过后备份旧文件，再保存新参数和配置。
backup_dir=
if [ -f "$config_file" ] || [ -f "$state_file" ]; then
    if [ -L "$CONFIG_DIR/backups" ]; then printf '%s\n' 'Backup directory must not be a symbolic link.' >&2; exit 1; fi
    mkdir -p "$CONFIG_DIR/backups"
    backup_dir=$(mktemp -d "$CONFIG_DIR/backups/config-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
    if [ -f "$config_file" ]; then cp -p "$config_file" "$backup_dir/config.json"; fi
    if [ -f "$state_file" ]; then cp -p "$state_file" "$backup_dir/credentials.env"; fi
fi
mv "$work_dir/credentials.env" "$state_file"
if ! mv "$work_dir/config.json" "$config_file"; then
    if [ -n "$backup_dir" ] && [ -f "$backup_dir/credentials.env" ]; then
        cp -p "$backup_dir/credentials.env" "$state_file"
    fi
    exit 1
fi
if [ "$verbose" = true ] && [ -n "$backup_dir" ]; then printf 'Backup: %s\n' "$backup_dir"; fi
printf 'PASS: configuration generated and checked (%s)\n' "$config_file"
