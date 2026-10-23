#!/bin/sh
# 第二步：下载并校验 sing-box 核心，确认它能够在当前服务器执行。
# 用法：sh scripts/02-download-core.sh [--dry-run] [--verbose]
# 可选：CORE_ROOT=/自定义目录 sh scripts/02-download-core.sh
set -eu
umask 022

# 1. 固定版本和保存位置。升级版本时，必须同时更新下方的四个校验值。
VERSION=1.14.3
CORE_ROOT=${CORE_ROOT:-/opt/singbox/core}

dry_run=false
verbose=false
for argument in "$@"; do
    case "$argument" in
        --dry-run) dry_run=true ;;
        --verbose) verbose=true ;;
        *) printf '%s\n' 'Usage: sh scripts/02-download-core.sh [--dry-run] [--verbose]' >&2; exit 2 ;;
    esac
done
case "$CORE_ROOT" in
    /*) ;;
    *) printf '%s\n' 'CORE_ROOT must be an absolute path.' >&2; exit 2 ;;
esac

# 2. 识别 Debian / Alpine 和 CPU，选择对应的 glibc / musl 构建。
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
. "$script_dir/../lib/platform.sh"
sb_detect_platform

# 以下 SHA-256 来自官方 1.14.3 发布页，已于 2026-10-23 核对：
# https://github.com/SagerNet/sing-box/releases/expanded_assets/v1.14.3
case "$SB_OS_ID-$SB_ARCH" in
    debian-amd64)
        expected_sha256=cadbaded70a635d0c37bf52614d8e3116542243247211e0b441328595c62acb6
        ;;
    debian-arm64)
        expected_sha256=1612ea46765912efda931a817cf31d830a6e94065a80e3fde9094fa49ab7cd54
        ;;
    alpine-amd64)
        expected_sha256=41fc81fd041134d4d7d850a928d7d2cde17a7d6563953f406b22d32a68bfab1f
        ;;
    alpine-arm64)
        expected_sha256=12d6d67a4edf0dd54590865b1f4f79cd09ae043a02d648e9d1b5fccc8446ee07
        ;;
    *) printf '%s\n' 'No verified release asset for this platform.' >&2; exit 1 ;;
esac

asset_directory="sing-box-$VERSION-linux-$SB_ARCH-$SB_LIBC"
asset_file="$asset_directory.tar.gz"
download_url="https://github.com/SagerNet/sing-box/releases/download/v$VERSION/$asset_file"
version_directory="$CORE_ROOT/$VERSION-linux-$SB_ARCH-$SB_LIBC"
core_path="$version_directory/sing-box"

if [ "$dry_run" = true ] || [ "$verbose" = true ]; then
    printf 'VERSION=%s\nASSET=%s\nCORE_PATH=%s\n' "$VERSION" "$asset_file" "$core_path"
fi
if [ "$verbose" = true ]; then
    printf 'URL=%s\nSHA256=%s\n' "$download_url" "$expected_sha256"
fi

# 预览到这里结束：不建目录、不下载、不执行核心。
if [ "$dry_run" = true ]; then
    exit 0
fi

# 3. 检查依赖。缺工具时停止，由你决定是否安装依赖。
for required_tool in tar gzip sha256sum mktemp cmp grep; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
        printf 'Missing required tool: %s\n' "$required_tool" >&2
        printf '%s\n' 'Debian: apt-get update && apt-get install -y ca-certificates curl tar gzip coreutils' >&2
        printf '%s\n' 'Alpine: apk add --no-cache ca-certificates curl tar gzip coreutils' >&2
        exit 1
    fi
done
if command -v curl >/dev/null 2>&1; then
    downloader=curl
elif command -v wget >/dev/null 2>&1; then
    downloader=wget
else
    printf '%s\n' 'Install curl or wget and ca-certificates before downloading.' >&2
    exit 1
fi

mkdir -p "$CORE_ROOT"
work_directory=$(mktemp -d "$CORE_ROOT/.download.XXXXXX")
archive_path="$work_directory/archive.tar.gz"
candidate_path="$work_directory/sing-box"

# 只清理本次创建的两个临时文件和空目录；正式版本目录保留。
cleanup() {
    rm -f "$archive_path" "$candidate_path"
    rmdir "$work_directory"
}
trap cleanup 0
trap 'exit 1' 1 2 15

# 4. 下载官方压缩包，实时显示进度，沿用 HTTPS 证书校验。
printf 'Downloading sing-box %s...\n' "$VERSION"
if [ "$downloader" = curl ]; then
    curl --progress-bar --fail --location --show-error --connect-timeout 15 --max-time 300 --retry 2 \
        --output "$archive_path" "$download_url"
else
    wget -T 60 -O "$archive_path" "$download_url"
fi

# 5. 先校验，成功后才解压和执行。校验失败时立即退出。
if ! checksum_output=$(printf '%s  %s\n' "$expected_sha256" "$archive_path" | sha256sum -c - 2>&1); then
    printf '%s\n' "$checksum_output" >&2
    exit 1
fi
if [ "$verbose" = true ]; then printf '%s\n' "$checksum_output"; fi

tar -xzOf "$archive_path" "$asset_directory/sing-box" > "$candidate_path"
chmod 0755 "$candidate_path"
version_output=$("$candidate_path" version)
if [ "$verbose" = true ]; then printf '%s\n' "$version_output"; fi
if ! printf '%s\n' "$version_output" | grep -Fxq "sing-box version $VERSION"; then
    printf '%s\n' "$version_output" >&2
    printf '%s\n' 'The extracted core did not report the expected version.' >&2
    exit 1
fi

# 6. 版本验证通过后才保存核心。已有相同文件可复用，不同文件则停止。
if [ -e "$version_directory" ] || [ -L "$version_directory" ]; then
    if [ -f "$core_path" ] && cmp -s "$candidate_path" "$core_path"; then
        printf '%s\n' 'The same verified core is already present.'
    else
        printf 'Existing path has different contents; review it before retrying: %s\n' "$version_directory" >&2
        exit 1
    fi
else
    mkdir "$version_directory"
    mv "$candidate_path" "$core_path"
fi

printf 'PASS: core is ready at %s\n' "$core_path"
