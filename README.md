# singbox-deploy

为 Debian 和 Alpine 提供可读、可分步执行的 sing-box 安装脚本，也可一键安装。

固定版本 **1.14.3**，同时配置 **AnyTLS＋REALITY** 和 **VLESS＋REALITY＋Vision**，使用服务器自身出口，自动注册服务并开启开机自启。

| 系统 | 架构 | 服务管理器 |
|---|---|---|
| Debian | amd64 / arm64 | systemd |
| Alpine | amd64 / arm64 | OpenRC |

## 安装

下载或克隆整个仓库，以 root 身份进入项目目录执行；不要只下载 `install.sh`：

```sh
sh install.sh
```

入口从上到下执行：检查环境 → 安装缺少的基础依赖 → 下载并校验官方核心 → 建立命令入口 → 注册服务与自启 → 生成配置 → 启动并检查监听。

下载进度实时显示，默认只显示步骤与最终结果。任何一步失败都会停止，显示出错步骤；修复后可以重新运行。已有不同的核心入口、服务定义或无匹配凭据的配置不会被覆盖。

重复运行会重新下载校验核心，复用已有密码、UUID、密钥和已保存参数，并重启服务应用配置。**已有连接会短暂中断。** 重试保留已完成部分，不会自动清理或回滚全部环境。

预览安装计划，不安装依赖、不下载或改服务：

```sh
sh install.sh --dry-run
```

查看各步骤的详细输出：

```sh
sh install.sh --verbose
```

`--dry-run` 检查当前平台和项目文件并展示流程；完整的核心、配置和服务检查在实际执行对应步骤时完成。

## 默认配置

| 项目 | 默认值 |
|---|---|
| AnyTLS＋REALITY | TCP `10443`，共享密码 |
| VLESS＋REALITY＋Vision | TCP `11443`，共享 UUID |
| 监听地址 | `0.0.0.0` |
| REALITY 目标 | `www.apple.com:443` |
| 出口 | 服务器自身出口 |
| 核心目录 | `/opt/singbox/core` |
| 核心命令 | `/usr/local/bin/sing-box` |
| 服务端配置 | `/etc/sing-box/config.json` |
| 持久参数与凭据 | `/etc/sing-box/credentials.env`，权限 `600` |

所有设备可以共用一组连接参数。首次执行生成认证信息，后续复用。要调整端口或握手目标，在安装命令前传入参数，成功后会保存：

```sh
ANYTLS_PORT=20443 VLESS_PORT=21443 REALITY_SERVER=www.apple.com sh install.sh
```

一键入口使用表内固定安装路径。`CORE_ROOT`、`BIN_DIR`、`SING_BOX` 和 `CONFIG_DIR` 若在当前环境中设置为其他路径，需要先取消这些变量，避免与服务模板混用。

## 安装后

只检查服务、自启和两个 TCP 监听，不重启：

```sh
sh scripts/06-start-service.sh --check
```

Debian 使用 systemd，Alpine 使用 OpenRC。日志位置：

```sh
# Debian
journalctl -u sing-box.service -n 30 --no-pager

# Alpine
tail -n 30 /var/log/sing-box/stderr.log
```

独立公网 IP 使用公网地址和监听端口；NAT 小鸡按供应商分配确认公网 TCP 端口到内部 TCP 端口的映射。公网端口可以选 20000 以上，实际以供应商分配范围为准。安装程序只输出内部端口，不配置供应商 NAT 或防火墙，不需要 API Key。

客户端导入格式可另行整理。需要公网地址、对外端口、协议和对应认证参数，REALITY 使用公钥。含私钥的整个服务端配置和凭据文件保留在服务器。监听检查通过后，还需实际客户端连接测试才能确认公网可用。

## 从头测试

预览清理范围，再按需执行清理：

```sh
sh scripts/00-reset-environment.sh
sh scripts/00-reset-environment.sh --apply
```

清理会停止本项目服务、取消自启，把部署文件移入 `/var/backups/singbox-manual/` 下的私有备份，然后可重新执行 `sh install.sh`。一键安装本身不会调用清理脚本。

## 项目结构

```text
install.sh     一键安装入口，调用 01～06
scripts/       00 清理；01～06 分步操作
lib/           Debian / Alpine 环境识别
config/        可读的 JSON 模板和字段说明
service/       systemd / OpenRC 服务模板
docs/          分步操作和开发验收手册
tools/         Windows 上传工具、SSH 自动验收工具
tests/         回归检查
generated/     忽略提交的打包文件、原始测试报告
```

Windows 上传工具 `tools/test-remote.ps1` 通过一次 SSH 连接上传项目并执行检查，**不会自动安装**。上传后进入输出的远端目录执行 `sh install.sh`。

详细操作见 [分步手册](docs/manual.md)，配置字段见 [配置说明](config/README.md)。开发时执行 `sh check.sh --offline` 检查语法和平台分支；其他验收命令见分步手册。

一键入口已在 Debian / systemd 和 Alpine / OpenRC 的 amd64 测试机上完成真实下载、首次安装和重复安装验收，各通过 15 个阶段及 18 项隔离回归。测试方式和范围见 [测试说明](docs/testing.md)。
