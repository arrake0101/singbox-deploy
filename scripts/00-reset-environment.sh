#!/bin/sh
# 一键清理本项目部署：停止服务、取消自启，把部署文件移入私有备份目录。
# 默认只预览；明确执行：sh scripts/00-reset-environment.sh --apply
# 这是本项目的卸载还原，不是整台服务器的系统快照恢复。
set -eu
umask 077

# 1. 清理范围固定写在这里，便于核对；备份保存在清理范围之外。
core_root=/opt/singbox/core
command_link=/usr/local/bin/sing-box
config_dir=/etc/sing-box
data_dir=/var/lib/sing-box
log_dir=/var/log/sing-box
backup_root=/var/backups/singbox-manual

apply=false
dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --apply) apply=true ;;
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/00-reset-environment.sh [--apply] [--verbose]' >&2; exit 2 ;;
    esac
done
if [ "$apply" = true ] && [ "$dry_run" = true ]; then
    printf '%s\n' 'Choose either --apply or --dry-run.' >&2
    exit 2
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$script_dir/../lib/platform.sh"
sb_detect_platform
if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this reset script as root.' >&2
    exit 1
fi
case "$SB_OS_ID" in
    alpine)
        manager=openrc
        service_file=/etc/init.d/sing-box
        template="$script_dir/../service/sing-box.openrc"
        ;;
    debian)
        manager=systemd
        service_file=/etc/systemd/system/sing-box.service
        template="$script_dir/../service/sing-box.service"
        ;;
esac

# 2. 在停服务或移动文件之前，检查所有路径的归属。
has_service=false
owned=false
if [ -e "$service_file" ] || [ -L "$service_file" ]; then
    if [ -L "$service_file" ] || [ ! -f "$service_file" ] || ! cmp -s "$template" "$service_file"; then
        printf 'Service does not match this project; nothing was changed: %s\n' "$service_file" >&2
        exit 1
    fi
    has_service=true
    owned=true
fi
if [ -e "$command_link" ] || [ -L "$command_link" ]; then
    if [ ! -L "$command_link" ] || [ "$(readlink "$command_link")" != "$core_root/current/sing-box" ]; then
        printf 'Command does not match this project; nothing was changed: %s\n' "$command_link" >&2
        exit 1
    fi
    owned=true
fi
for directory in "$core_root" "$config_dir" "$data_dir" "$log_dir"; do
    if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
        printf 'Unexpected directory path; nothing was changed: %s\n' "$directory" >&2
        exit 1
    fi
done
if [ -e "$core_root/current" ] || [ -L "$core_root/current" ]; then
    if [ ! -L "$core_root/current" ]; then
        printf '%s\n' 'Core current entry is not a project link; nothing was changed.' >&2
        exit 1
    fi
    current_target=$(readlink -f "$core_root/current")
    case "$current_target" in
        "$core_root"/*) owned=true ;;
        *) printf '%s\n' 'Core current link points outside this project; nothing was changed.' >&2; exit 1 ;;
    esac
fi
if [ -f "$core_root/1.14.3-linux-$SB_ARCH-$SB_LIBC/sing-box" ]; then
    owned=true
fi
if [ "$SB_SERVICE_RUNTIME" = systemd ]; then
    loaded_file=$(systemctl show -p FragmentPath --value sing-box.service 2>/dev/null || true)
    if [ -n "$loaded_file" ] && { [ "$has_service" != true ] || [ "$loaded_file" != "$service_file" ]; }; then
        printf 'Another service definition is loaded; nothing was changed: %s\n' "$loaded_file" >&2
        exit 1
    fi
fi
if [ "$has_service" = true ] && [ "$SB_SERVICE_RUNTIME" != "$manager" ]; then
    printf 'A running %s instance is required to stop and disable this service.\n' "$manager" >&2
    exit 1
fi

# OpenRC 的其他运行级别也要检查，避免清理到别的服务链接。
if [ "$manager" = openrc ]; then
    for entry in /etc/runlevels/*/sing-box; do
        if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
        if [ "$has_service" != true ] || [ ! -L "$entry" ] || [ "$(readlink -f "$entry")" != "$service_file" ]; then
            printf 'Unexpected startup registration; nothing was changed: %s\n' "$entry" >&2
            exit 1
        fi
    done
fi

# 3. 默认列出将移入备份的路径，不创建备份、不停止服务。
found=false
for path in "$service_file" "$command_link" "$core_root" "$config_dir" "$data_dir" "$log_dir"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
        found=true
        if [ "$apply" != true ]; then printf 'BACKUP_AND_REMOVE=%s\n' "$path"; fi
    fi
done
if [ "$found" != true ]; then
    printf '%s\n' 'PASS: no current project deployment found'
    exit 0
fi
if [ "$owned" != true ]; then
    printf '%s\n' 'No matching project core, command or service was found; nothing was changed.' >&2
    exit 1
fi
if [ "$apply" != true ]; then
    if [ "$has_service" = true ]; then printf 'STOP_AND_DISABLE=sing-box (%s)\n' "$manager"; fi
    printf '%s\n' 'Preview only. Use --apply to reset this project deployment.'
    exit 0
fi

# 4. 创建私有备份。清理通过移动完成，不递归删除配置或日志。
if [ -L "$backup_root" ]; then
    printf '%s\n' 'Backup root must not be a symbolic link.' >&2
    exit 1
fi
mkdir -p "$backup_root"
backup_dir=$(mktemp -d "$backup_root/reset-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
printf 'Backup: %s\n' "$backup_dir"
printf 'OS=%s\nSERVICE_MANAGER=%s\nSERVICE_FILE=%s\n' "$SB_OS_ID" "$manager" "$service_file" > "$backup_dir/manifest.txt"

# 原生命令失败时停止，完整显示错误，保留备份供排查。
run_quietly() {
    if ! command_output=$("$@" 2>&1); then
        printf '%s\n' "$command_output" >&2
        return 1
    fi
}

# 5. 只停止 sing-box，取消它的自启；其他服务不在清理范围内。
if [ "$has_service" = true ]; then
    if [ "$manager" = openrc ]; then
        if rc-service -q sing-box status >/dev/null 2>&1; then
            printf '%s\n' 'WAS_ACTIVE=true' >> "$backup_dir/manifest.txt"
            run_quietly rc-service sing-box stop
        else
            printf '%s\n' 'WAS_ACTIVE=false' >> "$backup_dir/manifest.txt"
        fi
        for entry in /etc/runlevels/*/sing-box; do
            if [ ! -L "$entry" ]; then continue; fi
            runlevel=$(basename "$(dirname "$entry")")
            printf 'RUNLEVEL=%s\n' "$runlevel" >> "$backup_dir/manifest.txt"
            run_quietly rc-update del sing-box "$runlevel"
        done
    else
        if systemctl is-active --quiet sing-box.service; then
            printf '%s\n' 'WAS_ACTIVE=true' >> "$backup_dir/manifest.txt"
        else
            printf '%s\n' 'WAS_ACTIVE=false' >> "$backup_dir/manifest.txt"
        fi
        if systemctl is-enabled --quiet sing-box.service; then
            printf '%s\n' 'WAS_ENABLED=true' >> "$backup_dir/manifest.txt"
        else
            printf '%s\n' 'WAS_ENABLED=false' >> "$backup_dir/manifest.txt"
        fi
        run_quietly systemctl stop sing-box.service
        run_quietly systemctl disable sing-box.service
        # disable 可能使未运行的 unit 被卸载；清理不需要再调用 reset-failed。
    fi
fi

# 6. 保留原绝对路径结构，例如备份中的 etc/sing-box/config.json。
for path in "$service_file" "$command_link" "$core_root" "$config_dir" "$data_dir" "$log_dir"; do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
    destination="$backup_dir$path"
    mkdir -p "$(dirname "$destination")"
    mv "$path" "$destination"
    printf 'MOVED=%s\n' "$path" >> "$backup_dir/manifest.txt"
    if [ "$verbose" = true ]; then printf 'Moved: %s\n' "$path"; fi
done
if [ "$has_service" = true ] && [ "$manager" = systemd ]; then
    run_quietly systemctl daemon-reload
fi

# 只尝试移除项目的空父目录；里面还有其他文件时保留。
rmdir /opt/singbox 2>/dev/null || true
hash -r 2>/dev/null || true
printf '%s\n' 'PASS: current project deployment reset; files preserved in backup'
