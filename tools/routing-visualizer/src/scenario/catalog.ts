import type { ConfigModel } from '../config/types'
import type { Scenario } from '../engine/simulate'
import type { IpClass, Outcome } from '../engine/types'

export interface TargetPreset {
  id: string
  label: string
  domain?: string
  /** 该域名属于哪些域名规则集（规则集内容是外部数据，这里按常识给出示例）。 */
  sets?: string[]
  realIp?: IpClass
  ipClass?: IpClass
  hint?: string
}

export const TARGETS: TargetPreset[] = [
  { id: 'claude.ai', label: 'claude.ai', domain: 'claude.ai', sets: ['claude-domains', 'geosite-geolocation-!cn'], realIp: 'foreign' },
  { id: 'api.anthropic.com', label: 'api.anthropic.com', domain: 'api.anthropic.com', sets: ['claude-domains', 'geosite-geolocation-!cn'], realIp: 'foreign' },
  { id: 'www.google.com', label: 'www.google.com', domain: 'www.google.com', sets: ['geosite-geolocation-!cn'], realIp: 'foreign' },
  { id: 'www.youtube.com', label: 'www.youtube.com', domain: 'www.youtube.com', sets: ['geosite-geolocation-!cn'], realIp: 'foreign' },
  { id: 'stun.l.google.com', label: 'stun.l.google.com', domain: 'stun.l.google.com', sets: ['fakeipfilter-!cn', 'geosite-geolocation-!cn'], realIp: 'foreign', hint: '示例：fakeipfilter-!cn 成员' },
  { id: 'www.baidu.com', label: 'www.baidu.com', domain: 'www.baidu.com', sets: ['geosite-cn'], realIp: 'cn' },
  { id: 'www.bilibili.com', label: 'www.bilibili.com', domain: 'www.bilibili.com', sets: ['geosite-cn'], realIp: 'cn' },
  { id: 'ntp.aliyun.com', label: 'ntp.aliyun.com', domain: 'ntp.aliyun.com', sets: ['fakeipfilter-cn', 'geosite-cn'], realIp: 'cn', hint: '示例：fakeipfilter-cn 成员' },
  { id: 'cdn.unknown-cn.example', label: 'cdn.unknown-cn.example', domain: 'cdn.unknown-cn.example', sets: [], realIp: 'cn', hint: '不在任何集合，解析到国内 IP' },
  { id: 'api.unknown-intl.example', label: 'api.unknown-intl.example', domain: 'api.unknown-intl.example', sets: [], realIp: 'foreign', hint: '不在任何集合，解析到国外 IP' },
  { id: 'localhost', label: 'localhost / router.lan', domain: 'localhost', sets: ['geosite-private'], realIp: 'private' },
  { id: 'courier.push.apple.com', label: 'courier.push.apple.com', domain: '1-courier.push.apple.com', sets: [], realIp: 'foreign' },
  { id: 'custom', label: '自定义域名…', domain: 'example.com', sets: [], realIp: 'foreign' },
  { id: 'ip-private', label: '192.168.1.10（私网）', ipClass: 'private' },
  { id: 'ip-cn', label: '110.242.68.66（国内）', ipClass: 'cn' },
  { id: 'ip-foreign', label: '142.250.66.68（国外）', ipClass: 'foreign' },
  { id: 'ip-telegram', label: '91.108.56.130（Telegram）', ipClass: 'telegram' },
]

export interface ProcessPreset {
  id: string
  label: string
  name: string | null
  path: string | null
}

export const PROCESSES: ProcessPreset[] = [
  { id: 'browser', label: '浏览器 chrome.exe', name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { id: 'claude-exe', label: 'claude.exe（进程名）', name: 'claude.exe', path: 'C:\\Users\\me\\AppData\\Local\\Programs\\claude\\claude.exe' },
  { id: 'claude-cli', label: 'Claude CLI（versions 路径）', name: '2.1.42', path: '/home/me/.local/share/claude/versions/2.1.42' },
  { id: 'unknown', label: '未识别进程', name: null, path: null },
]

export interface ConnPreset {
  id: string
  label: string
  network: 'tcp' | 'udp'
  port: number
  protocol: string | null
}

export const CONNS: ConnPreset[] = [
  { id: 'tls', label: 'TCP 443 · TLS', network: 'tcp', port: 443, protocol: 'tls' },
  { id: 'http', label: 'TCP 80 · HTTP', network: 'tcp', port: 80, protocol: 'http' },
  { id: 'quic', label: 'UDP 443 · QUIC', network: 'udp', port: 443, protocol: 'quic' },
  { id: 'stun', label: 'UDP 3478 · STUN', network: 'udp', port: 3478, protocol: 'stun' },
  { id: 'dot', label: 'TCP 853 · DoT', network: 'tcp', port: 853, protocol: 'tls' },
  { id: 'tcp-raw', label: 'TCP 22 · 未知协议', network: 'tcp', port: 22, protocol: null },
  { id: 'udp-raw', label: 'UDP 50000 · 未知协议', network: 'udp', port: 50000, protocol: null },
]

export const QUERY_TYPES = ['A', 'AAAA', 'HTTPS', 'SVCB', 'TXT']
export const MODES = ['Rule', 'Global', 'Direct']

/** 侧栏表单状态。 */
export interface ScenarioInput {
  mode: string
  inbound: string
  processId: string
  dnsKeepsProcess: boolean
  targetId: string
  customDomain?: string
  /** 覆盖目标预设的规则集归属。 */
  sets?: string[]
  realIp?: IpClass
  queryType: string
  connId: string
}

export const DEFAULT_INPUT: ScenarioInput = {
  mode: 'Rule', inbound: 'tun-in', processId: 'browser', dnsKeepsProcess: true,
  targetId: 'claude.ai', queryType: 'A', connId: 'tls',
}

export function toScenario(input: ScenarioInput, model: ConfigModel): Scenario {
  const t = TARGETS.find((x) => x.id === input.targetId) ?? TARGETS[0]
  const p = PROCESSES.find((x) => x.id === input.processId) ?? PROCESSES[0]
  const c = CONNS.find((x) => x.id === input.connId) ?? CONNS[0]
  const inbound = model.inbounds.some((i) => i.tag === input.inbound) ? input.inbound : model.inbounds[0]?.tag ?? input.inbound
  const target: Scenario['target'] = t.ipClass
    ? { kind: 'ip', cls: t.ipClass }
    : {
        kind: 'domain',
        domain: t.id === 'custom' ? input.customDomain?.trim() || t.domain! : t.domain!,
        sets: input.sets ?? t.sets ?? [],
        realIp: input.realIp ?? t.realIp ?? 'foreign',
      }
  return {
    mode: input.mode, inbound, dnsKeepsProcess: input.dnsKeepsProcess, queryType: input.queryType,
    process: { name: p.name, path: p.path, label: p.label },
    conn: { network: c.network, port: c.port, protocol: c.protocol, label: c.label },
    target,
  }
}

export interface Preset {
  id: string
  group: string
  title: string
  patch: Partial<ScenarioInput>
  /** 针对仓库模板的期望结果，同时用作单元测试。 */
  expect: { kind: Outcome['kind']; outbound?: string; dnsServer?: string | null }
}

export const PRESETS: Preset[] = [
  { id: 'claude-browser', group: 'Claude', title: '浏览器访问 claude.ai', patch: { targetId: 'claude.ai' }, expect: { kind: 'outbound', outbound: 'Claude', dnsServer: 'dns_fakeip' } },
  { id: 'claude-exe', group: 'Claude', title: 'claude.exe 访问 api.anthropic.com', patch: { targetId: 'api.anthropic.com', processId: 'claude-exe' }, expect: { kind: 'outbound', outbound: 'Claude', dnsServer: 'dns_fakeip' } },
  { id: 'claude-cli-lost', group: 'Claude', title: 'Claude CLI，DNS 丢失进程身份', patch: { targetId: 'api.anthropic.com', processId: 'claude-cli', dnsKeepsProcess: false }, expect: { kind: 'outbound', outbound: 'Claude', dnsServer: 'dns_fakeip' } },
  { id: 'claude-in-google', group: 'Claude', title: 'claude-in 端口访问 google', patch: { targetId: 'www.google.com', inbound: 'claude-in' }, expect: { kind: 'outbound', outbound: 'Claude' } },
  { id: 'claude-quic', group: 'Claude', title: 'claude.ai 走 QUIC → 拒绝', patch: { targetId: 'claude.ai', connId: 'quic' }, expect: { kind: 'reject' } },
  { id: 'claude-localhost', group: 'Claude', title: 'claude.exe 查 localhost', patch: { targetId: 'localhost', processId: 'claude-exe' }, expect: { kind: 'outbound', outbound: 'Direct', dnsServer: 'dns_local' } },
  { id: 'claude-direct-mode', group: 'Claude', title: 'Direct 模式下的 claude.ai', patch: { targetId: 'claude.ai', mode: 'Direct' }, expect: { kind: 'outbound', outbound: 'Claude', dnsServer: 'dns_fakeip' } },

  { id: 'google', group: '国内外分流', title: '浏览器访问 www.google.com', patch: { targetId: 'www.google.com' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_fakeip' } },
  { id: 'baidu', group: '国内外分流', title: '浏览器访问 www.baidu.com', patch: { targetId: 'www.baidu.com' }, expect: { kind: 'outbound', outbound: 'Direct', dnsServer: 'dns_direct' } },
  { id: 'unknown-cn', group: '国内外分流', title: '未知域名 · 预查询得国内 IP', patch: { targetId: 'cdn.unknown-cn.example' }, expect: { kind: 'outbound', outbound: 'Direct', dnsServer: 'dns_direct' } },
  { id: 'unknown-intl', group: '国内外分流', title: '未知域名 · 预查询得国外 IP', patch: { targetId: 'api.unknown-intl.example' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_fakeip' } },
  { id: 'mixed-cn', group: '国内外分流', title: 'mixed-in 访问未知国内域名', patch: { targetId: 'cdn.unknown-cn.example', inbound: 'mixed-in' }, expect: { kind: 'outbound', outbound: 'Direct', dnsServer: 'dns_direct' } },
  { id: 'mixed-intl', group: '国内外分流', title: 'mixed-in 访问未知国外域名', patch: { targetId: 'api.unknown-intl.example', inbound: 'mixed-in' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_proxy' } },
  { id: 'fakeip-filter', group: '国内外分流', title: 'fakeipfilter-!cn 域名（真实 IP）', patch: { targetId: 'stun.l.google.com' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_proxy' } },
  { id: 'youtube-quic', group: '国内外分流', title: 'YouTube QUIC → 拒绝回退 TCP', patch: { targetId: 'www.youtube.com', connId: 'quic' }, expect: { kind: 'reject' } },

  { id: 'bili-aaaa', group: 'DNS 细节', title: 'bilibili AAAA → 空答复', patch: { targetId: 'www.bilibili.com', queryType: 'AAAA' }, expect: { kind: 'dns-only', dnsServer: null } },
  { id: 'google-aaaa', group: 'DNS 细节', title: 'google AAAA → FakeIP v6', patch: { targetId: 'www.google.com', queryType: 'AAAA' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_fakeip' } },
  { id: 'https-rr', group: 'DNS 细节', title: 'HTTPS 记录 → 空答复', patch: { targetId: 'www.google.com', queryType: 'HTTPS' }, expect: { kind: 'dns-only', dnsServer: null } },
  { id: 'txt-final', group: 'DNS 细节', title: 'TXT 记录 → final', patch: { targetId: 'api.unknown-intl.example', queryType: 'TXT' }, expect: { kind: 'dns-only', dnsServer: 'dns_proxy' } },
  { id: 'claude-txt', group: 'DNS 细节', title: 'claude.ai TXT → dns_claude', patch: { targetId: 'claude.ai', queryType: 'TXT' }, expect: { kind: 'dns-only', dnsServer: 'dns_claude' } },

  { id: 'global-baidu', group: '模式', title: 'Global 模式访问 baidu', patch: { targetId: 'www.baidu.com', mode: 'Global' }, expect: { kind: 'outbound', outbound: 'Proxy', dnsServer: 'dns_fakeip' } },
  { id: 'direct-google', group: '模式', title: 'Direct 模式访问 google', patch: { targetId: 'www.google.com', mode: 'Direct' }, expect: { kind: 'outbound', outbound: 'Direct', dnsServer: 'dns_direct' } },

  { id: 'lan', group: '裸 IP / 其他', title: '局域网 192.168.1.10', patch: { targetId: 'ip-private' }, expect: { kind: 'outbound', outbound: 'Direct' } },
  { id: 'telegram', group: '裸 IP / 其他', title: 'Telegram 裸 IP', patch: { targetId: 'ip-telegram' }, expect: { kind: 'outbound', outbound: 'Proxy' } },
  { id: 'dot', group: '裸 IP / 其他', title: '应用自带 DoT → 拒绝', patch: { targetId: 'ip-foreign', connId: 'dot' }, expect: { kind: 'reject' } },
  { id: 'ssh-cn', group: '裸 IP / 其他', title: 'SSH 到国内 IP', patch: { targetId: 'ip-cn', connId: 'tcp-raw' }, expect: { kind: 'outbound', outbound: 'Direct' } },
]

export function presetInput(p: Preset): ScenarioInput {
  return { ...DEFAULT_INPUT, ...p.patch }
}
