import type { RuleSetKind } from '../config/types'
import { inCidr } from './ip'
import type { CondResult, IpInfo, Meta, Trace } from './types'

/** 规则中属于「动作 / 动作参数」而不是匹配条件的字段。 */
const ACTION_KEYS = new Set([
  'action', 'server', 'outbound', 'rcode', 'answer', 'ns', 'extra', 'sniffer', 'timeout', 'no_drop', 'method',
  'client_subnet', 'rewrite_ttl', 'remove_client_subnet', 'disable_cache', 'strategy', 'invert', 'type', 'mode',
  'rules', 'override_address', 'override_port', 'udp_disable_domain_unmapping', 'udp_connect', 'udp_timeout',
  'tls_fragment', 'tls_record_fragment', 'network_strategy', 'fallback_delay', 'network_type', 'fallback_network_type',
])
/** sing-box 默认规则中同组字段之间是 OR 关系。 */
const DEST_FIELDS = new Set(['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'rule_set', 'ip_cidr', 'ip_is_private'])
const PORT_FIELDS = new Set(['port', 'port_range'])

export interface CondNode {
  id: string
  kind: 'and' | 'or' | 'leaf'
  invert?: boolean
  field?: string
  value?: any
  /** 位于带 match_response 的规则中：IP 条件匹配 DNS 响应。 */
  useResponse?: boolean
  /** 由默认规则字段分组产生的隐式 OR。 */
  implicit?: boolean
  children?: CondNode[]
}

export function actionOptions(rule: Record<string, any>): [string, any][] {
  return Object.entries(rule).filter(([k]) => ACTION_KEYS.has(k) && !['action', 'server', 'outbound', 'type', 'mode', 'rules', 'invert'].includes(k))
}

export function buildCond(rule: Record<string, any>, id = 'c'): CondNode {
  if (rule.type === 'logical') {
    return {
      id,
      kind: rule.mode === 'or' ? 'or' : 'and',
      invert: !!rule.invert,
      children: (rule.rules ?? []).map((r: any, i: number) => buildCond(r, `${id}.${i}`)),
    }
  }
  const useResponse = !!rule.match_response
  const leaf = (f: string): CondNode => ({ id: `${id}.${f}`, kind: 'leaf', field: f, value: rule[f], useResponse })
  const group = (fs: string[], gid: string): CondNode =>
    fs.length === 1 ? leaf(fs[0]) : { id: `${id}.${gid}`, kind: 'or', implicit: true, children: fs.map(leaf) }

  const fields = Object.keys(rule).filter((k) => !ACTION_KEYS.has(k))
  const dest = fields.filter((f) => DEST_FIELDS.has(f))
  const port = fields.filter((f) => PORT_FIELDS.has(f))
  const parts: CondNode[] = []
  let destDone = false
  let portDone = false
  for (const f of fields) {
    if (DEST_FIELDS.has(f)) {
      if (!destDone) parts.push(group(dest, 'dest'))
      destDone = true
    } else if (PORT_FIELDS.has(f)) {
      if (!portDone) parts.push(group(port, 'port'))
      portDone = true
    } else parts.push(leaf(f))
  }
  if (parts.length === 1) return { ...parts[0], invert: !!rule.invert || !!parts[0].invert }
  return { id, kind: 'and', invert: !!rule.invert, children: parts }
}

export interface EvalCtx {
  phase: 'dns' | 'route'
  ruleSetKinds: Record<string, RuleSetKind>
}

const arr = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const list = (v: any[], max = 3) => (v.length <= max ? v.join(', ') : `${v.slice(0, max).join(', ')} 等 ${v.length} 项`)

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src)
  } catch {
    return null
  }
}

function matchDomainSuffix(domain: string, suffix: string): boolean {
  const s = suffix.replace(/^\./, '')
  return domain === s || domain.endsWith('.' + s)
}

function evalLeaf(node: CondNode, m: Meta, ctx: EvalCtx): CondResult {
  const v = node.value
  const ip: IpInfo | null | undefined = node.useResponse ? m.response : m.ip
  const noIp = node.useResponse ? '没有 DNS 响应 IP' : '目标没有 IP（域名形式）'
  switch (node.field) {
    case 'inbound':
      return { ok: arr(v).includes(m.inbound), detail: `inbound=${m.inbound}` }
    case 'process_name':
      if (!m.processName) return { ok: false, detail: '未识别到进程' }
      return { ok: arr(v).includes(m.processName), detail: `进程名=${m.processName}` }
    case 'process_path':
      if (!m.processPath) return { ok: false, detail: '未识别到进程路径' }
      return { ok: arr(v).includes(m.processPath), detail: `进程路径=${m.processPath}` }
    case 'process_path_regex': {
      if (!m.processPath) return { ok: false, detail: '未识别到进程路径' }
      const ok = arr(v).some((re) => safeRegex(String(re))?.test(m.processPath!) ?? false)
      return { ok, detail: ok ? '进程路径匹配正则' : '进程路径不匹配正则' }
    }
    case 'query_type': {
      if (!m.queryType) return { ok: false, detail: '不是 DNS 查询' }
      const ok = arr(v).some((q) => String(q).toUpperCase() === m.queryType)
      return { ok, detail: `query_type=${m.queryType}` }
    }
    case 'clash_mode':
      return { ok: arr(v).some((x) => String(x).toLowerCase() === m.clashMode.toLowerCase()), detail: `模式=${m.clashMode}` }
    case 'match_response':
      return m.response ? { ok: true, detail: `有预查询响应 ${m.response.addr}` } : { ok: false, detail: '没有预查询响应' }
    case 'rule_set': {
      const tags = arr(v).map(String)
      const kindOf = (t: string) => ctx.ruleSetKinds[t] ?? 'domain'
      const ipAllowed = ctx.phase === 'route' || node.useResponse
      const hits = tags.filter((t) =>
        kindOf(t) === 'ip' ? ipAllowed && !!ip?.sets.includes(t) : !!m.domain && m.domainSets.includes(t),
      )
      if (hits.length) return { ok: true, detail: `命中 ${list(hits)}` }
      const allDomain = tags.every((t) => kindOf(t) === 'domain')
      const allIp = tags.every((t) => kindOf(t) === 'ip')
      if (allDomain && !m.domain) return { ok: false, detail: '没有域名可匹配' }
      if (allIp && !ipAllowed) return { ok: false, detail: 'DNS 规则中 IP 集合需配合 match_response' }
      if (allIp && !ip) return { ok: false, detail: noIp }
      return { ok: false, detail: `不在 ${list(tags)}` }
    }
    case 'domain':
      if (!m.domain) return { ok: false, detail: '没有域名可匹配' }
      return { ok: arr(v).includes(m.domain), detail: `域名=${m.domain}` }
    case 'domain_suffix': {
      if (!m.domain) return { ok: false, detail: '没有域名可匹配' }
      const ok = arr(v).some((s) => matchDomainSuffix(m.domain!, String(s)))
      return { ok, detail: ok ? `${m.domain} 后缀匹配` : `${m.domain} 后缀不匹配` }
    }
    case 'domain_keyword':
      if (!m.domain) return { ok: false, detail: '没有域名可匹配' }
      return { ok: arr(v).some((k) => m.domain!.includes(String(k))), detail: `域名=${m.domain}` }
    case 'domain_regex':
      if (!m.domain) return { ok: false, detail: '没有域名可匹配' }
      return { ok: arr(v).some((re) => safeRegex(String(re))?.test(m.domain!) ?? false), detail: `域名=${m.domain}` }
    case 'ip_is_private':
      if (!ip) return { ok: false, detail: noIp }
      return { ok: ip.private === !!v, detail: `${ip.addr} ${ip.private ? '是' : '不是'}私网地址` }
    case 'ip_cidr':
      if (!ip) return { ok: false, detail: noIp }
      return { ok: arr(v).some((c) => inCidr(ip.addr, String(c))), detail: `IP=${ip.addr}` }
    case 'port':
      if (m.port == null) return { ok: false, detail: '没有端口' }
      return { ok: arr(v).map(Number).includes(m.port), detail: `端口=${m.port}` }
    case 'port_range': {
      if (m.port == null) return { ok: false, detail: '没有端口' }
      const ok = arr(v).some((r) => {
        const [a, b] = String(r).split(':')
        return m.port! >= (a ? Number(a) : 0) && m.port! <= (b ? Number(b) : 65535)
      })
      return { ok, detail: `端口=${m.port}` }
    }
    case 'network':
      if (!m.network) return { ok: false, detail: '没有传输层信息' }
      return { ok: arr(v).includes(m.network), detail: `network=${m.network}` }
    case 'protocol':
      if (!m.protocol) return { ok: false, detail: '协议未知（未嗅探）' }
      return { ok: arr(v).includes(m.protocol), detail: `protocol=${m.protocol}` }
    default:
      return { ok: false, detail: `未模拟的字段 ${node.field}` }
  }
}

export function evalCond(node: CondNode, m: Meta, ctx: EvalCtx, trace: Trace): CondResult {
  let r: CondResult
  if (node.kind === 'leaf') {
    r = evalLeaf(node, m, ctx)
  } else {
    const rs = (node.children ?? []).map((c) => evalCond(c, m, ctx, trace))
    if (!rs.length) r = { ok: true, detail: '无条件' }
    else if (node.kind === 'and') {
      const fail = rs.find((x) => !x.ok)
      r = fail ? { ok: false, detail: fail.detail } : { ok: true, detail: rs.map((x) => x.detail).join('，') }
    } else {
      const hit = rs.find((x) => x.ok)
      r = hit ? { ok: true, detail: hit.detail } : { ok: false, detail: [...new Set(rs.map((x) => x.detail))].join('；') }
    }
  }
  if (node.invert) r = { ok: !r.ok, detail: r.ok ? `取反：${r.detail}` : `取反成立：${r.detail}` }
  trace[node.id] = r
  return r
}

/* ---------- 展示用标签 ---------- */

/** 把常见的路径正则还原成易读形式，如 .local/share/claude/versions/*。 */
export function humanizePathRegex(re: string): string {
  const s = re
    .replace(/\(\^\|\[\\\\\/\]\)/g, '')
    .replace(/\[\^\\\\\/\]\+/g, '*')
    .replace(/\[\\\\\/\]/g, '/')
    .replace(/\\\./g, '.')
    .replace(/^\^|\$$/g, '')
  return s.length > 40 ? `…${s.slice(-38)}` : s
}

export function leafLabel(node: CondNode): { text: string; title: string } {
  const v = node.value
  const vals = arr(v).map(String)
  const full = `${node.field}: ${JSON.stringify(v)}`
  switch (node.field) {
    case 'match_response':
    case 'ip_is_private':
      return { text: v === false ? `${node.field}=false` : node.field!, title: full }
    case 'rule_set':
      return { text: vals.length > 2 ? `rule_set: ${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : `rule_set: ${vals.join(', ')}`, title: vals.join('\n') }
    case 'process_path_regex':
      return { text: `process_path ~ ${humanizePathRegex(vals[0] ?? '')}${vals.length > 1 ? ` +${vals.length - 1}` : ''}`, title: `process_path_regex:\n${vals.join('\n')}` }
    default:
      return { text: vals.length === 1 ? `${node.field} = ${vals[0]}` : `${node.field} ∈ {${vals.join(', ')}}`, title: full }
  }
}
