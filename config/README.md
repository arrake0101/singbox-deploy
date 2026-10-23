# 配置文件约定

本目录保存公开模板与字段说明。真实配置及凭据由第五步在服务器生成。

入站字段依据 sing-box 1.14.3 的 [AnyTLS](https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.3/docs/configuration/inbound/anytls.md)、[VLESS](https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.3/docs/configuration/inbound/vless.md) 和 [TLS／REALITY](https://raw.githubusercontent.com/SagerNet/sing-box/v1.14.3/docs/configuration/shared/tls.md) 文档编写。

| 文件或目录 | 用途 |
|---|---|
| `server.template.json` | 第五步使用的完整 JSON 模板，含可替换占位参数 |
| `server.json` | 实际服务端配置，已加入忽略规则 |
| `client.json` | 实际客户端配置，已加入忽略规则 |
| `../private/` | 实际密钥、凭据等，已加入忽略规则 |
| `../generated/` | 后续生成的实际配置、导出包等，已加入忽略规则 |
| `/etc/sing-box/config.json` | 服务器生成的真实双协议配置，供后台服务读取 |
| `/etc/sing-box/credentials.env` | 服务器持久参数、共享认证和 REALITY 密钥，权限 600 |
| `/etc/sing-box/backups/` | 更新前的配置与凭据备份 |

## 模板的五个部分

- `log`：默认只记录警告和错误，带时间戳。
- `dns`：使用服务器系统 DNS，标签为 `system-dns`。
- `inbounds`：AnyTLS＋REALITY 和 VLESS＋REALITY＋Vision，各一个共享身份。
- `outbounds`：只有 `direct`，流量使用服务器自身出口。
- `route`：默认解析器为 `system-dns`，默认出口为 `direct`。

## 替换参数

| 占位参数 | 来源及含义 |
|---|---|
| `@@ANYTLS_PORT@@` | 内部 TCP 监听端口，默认 10443，生成时转换为 JSON 数字 |
| `@@VLESS_PORT@@` | 内部 TCP 监听端口，默认 11443，生成时转换为 JSON 数字 |
| `@@ANYTLS_PASSWORD@@` | 核心生成的随机密码，所有设备共用 |
| `@@VLESS_UUID@@` | 核心生成的 UUID，所有设备共用 |
| `@@REALITY_SERVER@@` | 握手目标及对应的 `server_name`，默认 www.apple.com |
| `@@REALITY_PRIVATE_KEY@@` | 此服务器的 REALITY 私钥，两个入站共用，仅保留在服务器 |
| `@@REALITY_SHORT_ID@@` | 此服务器生成的 short ID，客户端需使用匹配的值 |

对应公钥保存在 `credentials.env` 中，后续导出给客户端；公钥不放进服务端 JSON。

结构调整可编辑公开模板，端口和握手目标通过第五步参数调整。重新生成时以模板和持久参数为准，原文件会先备份。模板不直接作为运行配置使用。

Git 忽略规则只防止这些路径被常规添加到版本库。上传脚本时，应选择需要的文件，避免把本地真实配置一起打包上传。
