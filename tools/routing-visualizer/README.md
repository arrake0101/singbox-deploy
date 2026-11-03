# sing-box 路由流水栈可视化

把 `config/client-routing.template.jsonc` 的 **DNS 规则栈** 和 **业务路由栈** 做成可逐步回放的流水线：

- 规则直接从 jsonc 解析（含注释里的 D1 / B3 编号、分节说明、已注释的规则），配置改了，界面跟着改。
- 通用的 sing-box 规则匹配器：`logical and/or`、`invert`、`rule_set`、`query_type`、`inbound`、`process_*`、`clash_mode`、`match_response`、`port`、`network`、`protocol`、`ip_is_private` 等；动作支持 `route / predefined / evaluate / reject / sniff / hijack-dns / resolve`。
- 每条规则显示命中 / 未命中原因，条件芯片逐个标绿或划掉（悬停看具体原因）。
- **连接状态** 面板：实时显示规则看到的元数据（inbound、进程、端口、域名、目标 IP、协议、DNS 响应…），嗅探、FakeIP 还原、resolve 改动的字段会高亮 `旧值 → 新值`。
- 结果卡给出选择器 → 节点 → detour 前置链的完整出站链路。

## 使用

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run build      # 类型检查 + 打包成单文件 dist/index.html，可直接双击打开
npm test           # 用仓库模板跑全部场景预设的断言
```

- 页面右上角「载入配置…」或直接把 `.json/.jsonc` 拖进窗口，可以可视化任意兼容配置。
- 快捷键：`空格` 播放/暂停，`← →` 单步，`Home / End` 首尾。
- 深链接：`index.html#p=mixed-cn&step=12` 打开指定预设的指定帧。

## 目录

```
src/config/     jsonc 解析（含注释提取）→ ConfigModel
src/engine/     条件树构建与求值、DNS / 路由栈运行器、出站链路
src/scenario/   目标域名、进程、连接类型与场景预设（带期望结果）
src/ui/         视图：流水线、规则卡片、连接状态、结果、执行流水
tests/          vitest
```

## 模拟边界

规则集的**内容**是外部数据，不会下载；某个域名属于哪些规则集、真实解析到哪类 IP，由场景给定（侧栏可改）。另外：

- 每次解析只给出一个代表性 IP，不模拟多 IP 与 DNS 缓存。
- 内部解析（`resolve`、出站 `domain_resolver`）按「不使用 FakeIP 服务器」处理。
- 默认规则内同组字段（域名/IP 类、端口类）视为 OR，其余字段 AND，与 sing-box 语义一致的近似实现。
