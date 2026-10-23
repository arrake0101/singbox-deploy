# 分步操作

所有命令在服务器的项目根目录中以 root 执行。日常使用 `sh install.sh` 即可；下列分步脚本便于查看、排查和逐项操作。

## 01 检查环境

```sh
sh scripts/01-inspect.sh
sh scripts/01-inspect.sh --verbose
```

确认 Debian / Alpine、CPU 架构和实际运行的服务管理器，不安装软件。`--summary` 输出供工具读取的固定字段。

## 02 下载核心

```sh
sh scripts/02-download-core.sh
```

下载官方 1.14.3 对应架构的 glibc / musl 压缩包，显示进度，校验固定 SHA-256 后才解压和执行。核心保存在 `/opt/singbox/core/` 的版本目录。

## 03 安装命令

```sh
sh scripts/03-install-core.sh
```

创建 `/opt/singbox/core/current` 和 `/usr/local/bin/sing-box` 两个链接，检查实际命令及版本。遇到不同的已有入口时停止，不覆盖。

## 04 注册后台服务

```sh
sh scripts/04-install-service.sh
```

Debian 注册 `sing-box.service` 并启用自启；Alpine 注册 `/etc/init.d/sing-box` 并加入 `default` 运行级别。此时只注册，不启动。

## 05 生成双协议配置

```sh
sh scripts/05-configure-server.sh
```

生成 `/etc/sing-box/config.json` 与 `/etc/sing-box/credentials.env`，权限 `600`。首次生成密码、UUID 和 REALITY 密钥，后续复用；更新前检查并备份，未变化时不重写文件。

调整端口或握手目标：

```sh
ANYTLS_PORT=20443 VLESS_PORT=21443 REALITY_SERVER=www.apple.com sh scripts/05-configure-server.sh
```

参数会保存为后续默认值。模板字段见 [配置说明](../config/README.md)。

## 06 启动并检查

```sh
sh scripts/06-start-service.sh
```

未运行则启动，已运行则重启应用当前配置，会短暂中断连接。检查自启与配置中的两个 IPv4 全地址 TCP 监听，并确认套接字由使用该配置的核心持有。

只检查，不重启：

```sh
sh scripts/06-start-service.sh --check
```

02～06 支持 `--dry-run` 和 `--verbose`。预览仅验证该步骤当前所需条件；例如预览 03 之前，02 的核心文件应已存在。一键入口的 `--dry-run` 则可在尚未安装时查看整体计划。

## 00 清理部署

```sh
sh scripts/00-reset-environment.sh
sh scripts/00-reset-environment.sh --apply
```

第一条仅预览；第二条停止本项目服务、取消自启，将已识别的部署文件移入 `/var/backups/singbox-manual/`。遇到外部服务定义、异常链接或停止失败时中止。清理后可以重新安装，一键安装不会自动执行此脚本。

## Windows 上传

在 Windows 的项目根目录执行：

```powershell
.\tools\test-remote.ps1 -SshTarget root@YOUR_HOST -Port 22
```

选择 Plink 或 OpenSSH，通过一次 SSH 连接上传到 `/tmp/singbox-manual-随机ID/` 并执行 `check.sh`。Plink 使用大写 `-P`，OpenSSH 使用小写 `-p`。上传不会自动安装；进入显示的远端目录后再执行 `sh install.sh`。

添加 `-SshClient PuTTY` 或 `-SshClient OpenSSH` 可明确客户端，`-PrepareOnly` 只生成上传文件、不连接服务器。只上传代码和公开模板，不上传实际配置与凭据。

## 查看状态与日志

```sh
# Debian
systemctl status sing-box.service --no-pager
systemctl is-enabled sing-box.service
journalctl -u sing-box.service -n 30 --no-pager

# Alpine
rc-status default
rc-service sing-box status
tail -n 30 /var/log/sing-box/stderr.log
```

服务运行数据位于 `/var/lib/sing-box`。服务监听正常后，再根据实际网络确认防火墙、可选 NAT 映射和客户端连通。测试与维护方式见 [测试说明](testing.md)。
