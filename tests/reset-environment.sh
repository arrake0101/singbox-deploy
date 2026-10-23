#!/bin/sh
# Linux 隔离测试：把清理路径替换为 generated/ 内的模拟环境。
# 服务命令也使用模拟工具，不停止或卸载测试机上的真实部署。
set -eu
if [ "$(uname -s)" != Linux ]; then
    printf '%s\n' 'SKIP: reset regression checks require Linux symlinks'
    exit 0
fi
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
mkdir -p "$project_dir/generated"
test_root=$(mktemp -d "$project_dir/generated/reset-test.XXXXXX")

new_case() {
    case_dir="$test_root/$test_os-$1"
    mkdir -p "$case_dir/project/scripts" "$case_dir/project/lib" "$case_dir/project/service" "$case_dir/bin"
    cp "$project_dir/lib/platform.sh" "$case_dir/project/lib/platform.sh"
    cat >> "$case_dir/project/lib/platform.sh" <<'TEST_PLATFORM'
sb_detect_platform() {
    sb_platform_select "$RESET_TEST_OS" x86_64
    SB_SERVICE_RUNTIME=$SB_SERVICE_DEFAULT
}
TEST_PLATFORM
    cp "$project_dir/service/sing-box.openrc" "$case_dir/project/service/"
    cp "$project_dir/service/sing-box.service" "$case_dir/project/service/"
    sed -e "s|/opt/singbox|$case_dir/opt/singbox|g" \
        -e "s|/usr/local/bin|$case_dir/usr/local/bin|g" \
        -e "s|/etc/sing-box|$case_dir/etc/sing-box|g" \
        -e "s|/etc/init.d|$case_dir/etc/init.d|g" \
        -e "s|/etc/systemd|$case_dir/etc/systemd|g" \
        -e "s|/etc/runlevels|$case_dir/etc/runlevels|g" \
        -e "s|/var/lib/sing-box|$case_dir/var/lib/sing-box|g" \
        -e "s|/var/log/sing-box|$case_dir/var/log/sing-box|g" \
        -e "s|/var/backups/singbox-manual|$case_dir/var/backups/singbox-manual|g" \
        "$project_dir/scripts/00-reset-environment.sh" > "$case_dir/project/scripts/00-reset-environment.sh"
    if [ "$test_os" = alpine ]; then
        libc=musl
        service_file="$case_dir/etc/init.d/sing-box"
        boot_link="$case_dir/etc/runlevels/default/sing-box"
        template=sing-box.openrc
    else
        libc=glibc
        service_file="$case_dir/etc/systemd/system/sing-box.service"
        boot_link="$case_dir/etc/systemd/system/multi-user.target.wants/sing-box.service"
        template=sing-box.service
    fi
    core_dir="$case_dir/opt/singbox/core"
    config_dir="$case_dir/etc/sing-box"
    command_link="$case_dir/usr/local/bin/sing-box"
    backup_root="$case_dir/var/backups/singbox-manual"
    mkdir -p "$core_dir/1.14.3-linux-amd64-$libc" "$config_dir" \
        "$case_dir/var/lib/sing-box" "$case_dir/var/log/sing-box" \
        "$(dirname "$service_file")" "$(dirname "$boot_link")" "$(dirname "$command_link")"
    printf '%s\n' 'fixture core' > "$core_dir/1.14.3-linux-amd64-$libc/sing-box"
    printf '%s\n' 'fixture configuration' > "$config_dir/config.json"
    printf '%s\n' 'fixture state' > "$case_dir/var/lib/sing-box/state"
    printf '%s\n' 'fixture log' > "$case_dir/var/log/sing-box/output.log"
    cp "$project_dir/service/$template" "$service_file"
    ln -s "$core_dir/1.14.3-linux-amd64-$libc" "$core_dir/current"
    ln -s "$core_dir/current/sing-box" "$command_link"
    ln -s "$service_file" "$boot_link"
    printf '%s\n' active > "$case_dir/active"
    printf '%s\n' 'keep other program' > "$case_dir/other-program"

    cat > "$case_dir/bin/manager" <<'TEST_MANAGER'
#!/bin/sh
set -eu
case_dir=${RESET_CASE:?}
tool=${0##*/}
printf '%s %s\n' "$tool" "$*" >> "$case_dir/manager.log"
case "$tool" in
    systemctl)
        case "$1" in
            show)
                if [ -f "$case_dir/etc/systemd/system/sing-box.service" ]; then
                    printf '%s\n' "$case_dir/etc/systemd/system/sing-box.service"
                fi
                ;;
            is-active) test -f "$case_dir/active" ;;
            is-enabled) test -L "$case_dir/etc/systemd/system/multi-user.target.wants/sing-box.service" ;;
            stop)
                if [ "${RESET_FAIL_STOP:-0}" = 1 ]; then exit 9; fi
                rm -f "$case_dir/active"
                ;;
            disable)
                rm -f "$case_dir/etc/systemd/system/multi-user.target.wants/sing-box.service"
                printf '%s\n' unloaded > "$case_dir/unit-unloaded"
                ;;
            reset-failed)
                [ "$#" -eq 2 ] && [ "$2" = sing-box.service ]
                if [ -f "$case_dir/unit-unloaded" ]; then
                    printf '%s\n' 'Failed to reset failed state of unit sing-box.service: Unit sing-box.service not loaded.' >&2
                    exit 1
                fi
                ;;
            daemon-reload) ;;
            *) exit 8 ;;
        esac
        ;;
    rc-service)
        if [ "$1" = -q ]; then
            test -f "$case_dir/active"
        elif [ "$1" = sing-box ] && [ "$2" = stop ]; then
            if [ "${RESET_FAIL_STOP:-0}" = 1 ]; then exit 9; fi
            rm -f "$case_dir/active"
        else
            exit 8
        fi
        ;;
    rc-update)
        [ "$1" = del ] && [ "$2" = sing-box ]
        rm -f "$case_dir/etc/runlevels/$3/sing-box"
        ;;
esac
TEST_MANAGER
    chmod 0755 "$case_dir/bin/manager"
    for tool in systemctl rc-service rc-update; do ln -s manager "$case_dir/bin/$tool"; done
}

run_reset() {
    PATH="$case_dir/bin:$PATH" RESET_CASE="$case_dir" RESET_TEST_OS="$test_os" \
        sh "$case_dir/project/scripts/00-reset-environment.sh" "$@" > "$case_dir/result.log" 2>&1
}
expect_failure() {
    if run_reset "$@"; then
        printf 'FAIL: expected rejection in %s\n' "$case_dir" >&2
        exit 1
    fi
}

for test_os in debian alpine; do
    # 1. 默认预览不停止服务，也不创建备份或移动文件。
    new_case preview
    run_reset
    test -f "$case_dir/active" && test -L "$boot_link"
    test -f "$config_dir/config.json" && test ! -d "$backup_root"

    # 2. 执行清理，配置、核心和日志完整移入私有备份。
    new_case apply
    run_reset --apply || { cat "$case_dir/result.log" >&2; exit 1; }
    test ! -f "$case_dir/active" && test ! -L "$boot_link"
    test ! -e "$core_dir" && test ! -L "$command_link" && test ! -e "$service_file"
    test ! -e "$config_dir" && test ! -e "$case_dir/var/lib/sing-box" && test ! -e "$case_dir/var/log/sing-box"
    backup_dir=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d)
    test "$(stat -c '%a' "$backup_dir")" = 700
    test "$(cat "$backup_dir$config_dir/config.json")" = 'fixture configuration'
    test "$(cat "$backup_dir$core_dir/1.14.3-linux-amd64-$libc/sing-box")" = 'fixture core'
    test "$(cat "$backup_dir$case_dir/var/log/sing-box/output.log")" = 'fixture log'
    test "$(cat "$case_dir/other-program")" = 'keep other program'

    # 3. 重复执行是无操作，不创建第二份备份。
    run_reset --apply
    test "$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d)" = "$backup_dir"

    # 4. 外部服务定义不同，拒绝清理，保留所有文件和运行状态。
    new_case foreign-service
    printf '%s\n' 'foreign service' > "$service_file"
    expect_failure --apply
    test -f "$case_dir/active" && test -f "$config_dir/config.json" && test ! -d "$backup_root"

    # 5. 外部命令链接不符合本项目，拒绝清理。
    new_case foreign-command
    rm -f "$command_link"
    ln -s /bin/true "$command_link"
    expect_failure --apply
    test -f "$case_dir/active" && test -d "$core_dir"

    # 6. 配置目录为外部链接，拒绝清理。
    new_case foreign-config
    mv "$config_dir" "$case_dir/config-outside"
    ln -s "$case_dir/config-outside" "$config_dir"
    expect_failure --apply
    test "$(cat "$case_dir/config-outside/config.json")" = 'fixture configuration'

    # 7. 不允许把执行和预览参数混用。
    new_case conflicting-options
    expect_failure --apply --dry-run
    test -f "$case_dir/active" && test ! -d "$backup_root"

    # 8. 停止失败时不移动部署文件，也不取消自启。
    new_case stop-failure
    RESET_FAIL_STOP=1 expect_failure --apply
    test -f "$case_dir/active" && test -L "$boot_link"
    test -f "$config_dir/config.json" && test -L "$command_link"

    # 9. 上一次已停止并取消自启、unit 已卸载时，继续清理仍成功。
    new_case resume-after-disable
    rm -f "$case_dir/active" "$boot_link"
    printf '%s\n' unloaded > "$case_dir/unit-unloaded"
    run_reset --apply || { cat "$case_dir/result.log" >&2; exit 1; }
    test ! -e "$core_dir" && test ! -L "$command_link" && test ! -e "$service_file"
    test ! -e "$config_dir"
done

printf '%s\n' 'PASS: 18 isolated reset checks; real deployment untouched'
