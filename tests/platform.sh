#!/bin/sh
# Offline regression checks for OS/architecture selection and failure handling.
set -eu
test_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$test_dir/../lib/platform.sh"

test_cases=0
for test_os in debian alpine; do
    for test_cpu in x86_64 amd64 aarch64 arm64; do
        sb_platform_select "$test_os" "$test_cpu"
        case "$test_cpu" in
            x86_64|amd64) test_expected_arch=amd64 ;;
            aarch64|arm64) test_expected_arch=arm64 ;;
        esac
        case "$test_os" in
            debian) test_expected_libc=glibc; test_expected_service=systemd ;;
            alpine) test_expected_libc=musl; test_expected_service=openrc ;;
        esac
        [ "$SB_OS_ID" = "$test_os" ]
        [ "$SB_ARCH" = "$test_expected_arch" ]
        [ "$SB_LIBC" = "$test_expected_libc" ]
        [ "$SB_SERVICE_DEFAULT" = "$test_expected_service" ]
        test_cases=$((test_cases + 1))
    done
done

# Unsupported systems and CPUs must fail instead of selecting a wrong asset.
if sb_platform_select ubuntu x86_64 2>/dev/null; then
    printf '%s\n' 'FAIL: unsupported OS was accepted' >&2
    exit 1
fi
if sb_platform_select debian riscv64 2>/dev/null; then
    printf '%s\n' 'FAIL: unsupported architecture was accepted' >&2
    exit 1
fi
[ -z "$SB_ARCH" ]
printf 'PASS: %s supported combinations and 2 rejection cases\n' "$test_cases"
