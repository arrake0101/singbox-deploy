# 测试说明

以下命令在项目根目录执行。测试源码不包含服务器地址和认证信息；实机测试通过参数指定主机，密码隐藏输入，SSH 指纹需预先核对。

## 本地检查

```sh
sh check.sh --offline
```

验证 Shell 语法及 Debian / Alpine 的系统与架构选择，不安装软件或修改服务。

Windows 上传工具回归使用模拟 Plink，不连接服务器：

```powershell
.\tests\test-remote.ps1
```

验证单次连接、Plink 大写 `-P`、打包清单、LF 编码、只准备模式和失败处理。

Python 3.9+ 本地回归：

```sh
python tests/download-core.py
python tests/test_ssh_output.py
```

前者使用模拟压缩包和下载器，真实执行哈希校验、解压和保存，覆盖四个平台分支，共 14 项；后者验证 SSH 通道退出状态先于输出到达时仍能完整读取输出。

## Linux 隔离回归

以 root 在 Linux 中执行：

```sh
sh tests/install-core.sh
sh tests/reset-environment.sh
sh tests/install-entry.sh
```

模拟目录位于 `generated/`，不会操作真实服务或安装软件。分别覆盖核心入口冲突及回滚 10 项、清理环境与失败恢复 18 项、一键入口顺序及依赖处理 18 项。入口测试使用模拟包管理器。

## SSH 实机验收

本地安装 Python 3.9+ 与 Paramiko：

```sh
python -m pip install paramiko
python tools/test-install.py --host YOUR_HOST --port YOUR_SSH_PORT --fingerprint YOUR_VERIFIED_SHA256_FINGERPRINT
```

`test-install.py` 在私有临时目录准备项目副本，只替换安装路径和服务名，保持官方核心下载 URL 与 SHA-256 不变。使用随机空闲高端口和唯一临时服务，验证首次安装、重复安装、凭据与配置保持不变、服务重启及只检查模式。结束后清理临时服务与自启入口，正式部署保持原样。

其他工具使用相同的 `--host`、`--port`、`--fingerprint` 参数：

| 工具 | 验证范围 |
|---|---|
| `tools/test-server.py` | 下载、安装核心和注册服务；会操作真实核心入口和服务注册，不启动服务 |
| `tools/test-configuration.py` | 私有目录生成配置，回环地址验证两个协议各两个共享身份并发 HTTPS 请求 |
| `tools/test-start-service.py` | 临时服务启动、重启、监听归属和端口冲突保护 |

`test-server.py --service-only` 仅验收真实服务注册；`--reset-checks-only` 只做隔离清理与真实只读预览，不清理真实部署。

原始报告和临时打包文件写入 `generated/`，不提交到 Git。SSH 密码不写入文件，真实服务端配置和凭据也不在代码上传清单内。

## 已完成验收

2026-10-24，在 Debian 13 amd64 / systemd 与 Alpine 3.24 amd64 / OpenRC 上完成：

- 一键安装各 15 个阶段，包含首次真实下载、安装、启动、重复执行与临时服务清理。
- 两个系统的一键入口隔离回归各 18 项。
- 配置生成各 15 个阶段，包含两个协议分别两个共享身份的并发 HTTPS 请求及目标证书验证。
- 服务启动与异常保护各 29 个阶段。

arm64 有平台与下载分支离线覆盖，未进行 arm64 实机运行验收。没有据此验证供应商 NAT、设备 GUI 客户端导入、TUN、UDP、重启服务器后的恢复或公网连通。
