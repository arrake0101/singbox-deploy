#!/bin/sh
# Debian / Alpine 共用的环境判断，供检查脚本和后续安装脚本使用。
# 三个函数：根据输入选择平台 → 读取本机环境 → 打印结果。

# 输入：系统 ID、CPU 架构。输出：SB_OS_ID、SB_ARCH 等变量。
# SB_LIBC 是发行版预期的运行库，实际版本由检查脚本的 ldd 显示。
sb_platform_select() {
    SB_OS_ID=$1
    SB_ARCH=
    SB_LIBC=
    SB_SERVICE_DEFAULT=

    case "$SB_OS_ID" in
        debian)
            SB_LIBC=glibc
            SB_SERVICE_DEFAULT=systemd
            ;;
        alpine)
            SB_LIBC=musl
            SB_SERVICE_DEFAULT=openrc
            ;;
        *)
            printf 'Unsupported OS: %s (expected debian or alpine)\n' "$SB_OS_ID" >&2
            return 1
            ;;
    esac

    case "$2" in
        x86_64|amd64)
            SB_ARCH=amd64
            ;;
        aarch64|arm64)
            SB_ARCH=arm64
            ;;
        *)
            printf 'Unsupported CPU architecture: %s\n' "$2" >&2
            return 1
            ;;
    esac
}

# 读取当前 Linux 主机，判断正在使用的服务管理方式。
sb_detect_platform() {
    if [ "$(uname -s)" != Linux ]; then
        printf '%s\n' 'Run environment inspection on a Linux test machine.' >&2
        return 1
    fi
    if [ ! -r /etc/os-release ]; then
        printf '%s\n' 'Cannot read /etc/os-release' >&2
        return 1
    fi
    # 只读取 ID 字段，不把整个 os-release 当作 Shell 脚本执行。
    sb_detected_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d "\"'")
    sb_platform_select "$sb_detected_id" "$(uname -m)" || return 1

    SB_PID1=unknown
    if [ -r /proc/1/comm ]; then
        IFS= read -r SB_PID1 < /proc/1/comm || true
    fi
    # 发行版默认使用某工具，不代表容器中也运行着它。
    SB_SERVICE_RUNTIME=none
    if [ "$SB_PID1" = systemd ] && command -v systemctl >/dev/null 2>&1; then
        SB_SERVICE_RUNTIME=systemd
    elif [ -r /run/openrc/softlevel ] && command -v rc-service >/dev/null 2>&1; then
        SB_SERVICE_RUNTIME=openrc
    fi
}

# 保留固定字段名，便于对照检查结果。
sb_print_platform() {
    printf 'OS=%s\nARCH=%s\nEXPECTED_LIBC=%s\nDEFAULT_SERVICE_MANAGER=%s\nPID1=%s\nACTIVE_SERVICE_MANAGER=%s\n' \
        "$SB_OS_ID" "$SB_ARCH" "$SB_LIBC" "$SB_SERVICE_DEFAULT" "$SB_PID1" "$SB_SERVICE_RUNTIME"
}
