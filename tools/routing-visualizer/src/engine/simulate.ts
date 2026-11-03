import type { ConfigModel, RuleEntry } from '../config/types'
import { buildCond, evalCond, type CondNode, type EvalCtx } from './conditions'
import { fakeIp, ipClassLabel, makeIp } from './ip'
import { dnsServerDesc, outboundChain } from './outbound'
import type { Answer, DnsResult, IpClass, Meta, Outcome, SimResult, Step, Trace, Truth } from './types'

export interface Scenario {
  mode: string
  inbound: string
  process: { name: string | null; path: string | null; label?: string }
  /** DNS 查询能否识别到发起进程（系统 DNS 代发时会丢失）。 */
  dnsKeepsProcess: boolean
  target: { kind: 'domain'; domain: string; sets: string[]; realIp: IpClass } | { kind: 'ip'; cls: IpClass }
  queryType: string
  conn: { network: 'tcp' | 'udp'; port: number; protocol: string | null; label?: string }
}

const isAddrQuery = (q?: string) => q === 'A' || q === 'AAAA'
const SNIFF_DOMAIN_PROTOCOLS = ['tls', 'http', 'quic']
const DEFAULT_SNIFFERS = ['http', 'tls', 'quic', 'dns', 'stun', 'bittorrent', 'dtls', 'ssh', 'rdp', 'ntp']

/** 每条规则只构建一次条件树。 */
const condCache = new WeakMap<object, CondNode>()
export function condOf(rule: RuleEntry): CondNode {
  let c = condCache.get(rule.raw)
  if (!c) condCache.set(rule.raw, (c = buildCond(rule.raw)))
  return c
}

export const ruleLabel = (rules: RuleEntry[], i: number) => (i >= rules.length ? 'final' : rules[i].tag ?? `#${i + 1}`)

class Runner {
  steps: Step[] = []
  lastDns?: DnsResult
  constructor(readonly model: ConfigModel, readonly truth: Truth) {}

  push(s: Step) {
    this.steps.push(s)
  }

  match(rule: RuleEntry, meta: Meta, phase: EvalCtx['phase']) {
    const trace: Trace = {}
    const r = evalCond(condOf(rule), meta, { phase, ruleSetKinds: this.model.ruleSetKinds }, trace)
    return { ...r, trace }
  }

  realAnswer(qt: string | undefined): Answer {
    if (!isAddrQuery(qt)) return { kind: 'records', text: `${qt} 真实记录` }
    const ip = makeIp(this.truth.realIp, qt === 'AAAA')
    return { kind: 'real', ip, text: `${ip.addr}（${ipClassLabel(ip.cls)}）` }
  }

  answerFrom(server: string, qt: string | undefined): Answer {
    const s = this.model.dnsServers[server]
    if (s?.type === 'fakeip') {
      if (!isAddrQuery(qt)) return { kind: 'empty', text: `FakeIP 不处理 ${qt}，空答复` }
      const ip = fakeIp(s, qt === 'AAAA')
      return { kind: 'fake', ip, text: `${ip.addr}（FakeIP）` }
    }
    return this.realAnswer(qt)
  }

  /** 运行 DNS 规则栈。internal=true 表示 resolve / 出站解析，不允许 FakeIP。 */
  dns(metaIn: Meta, internal: boolean, subject = internal ? "内部解析查询" : "DNS 查询"): DnsResult {
    const { model } = this
    const meta: Meta = { ...metaIn, response: null }
    const snap = () => ({ subject, meta: structuredClone(meta) })
    const rules = model.dnsRules
    this.push({ t: 'reset', stack: 'dns' })
    for (const rule of rules) {
      const i = rule.index
      const m = this.match(rule, meta, 'dns')
      const base = { t: 'rule', stack: 'dns', index: i, trace: m.trace } as const
      if (!m.ok) {
        this.push({ ...base, ...snap(), status: 'skip', message: m.detail })
        continue
      }
      const action = rule.raw.action ?? 'route'
      const server: string | undefined = rule.raw.server
      if (action === 'route' && server) {
        if (internal && model.dnsServers[server]?.type === 'fakeip') {
          this.push({ ...base, ...snap(), status: 'skip', message: `${m.detail}；但内部解析不使用 FakeIP，跳过` })
          continue
        }
        const answer = this.answerFrom(server, meta.queryType)
        this.push({ ...base, ...snap(), status: 'hit', message: `${m.detail} → ${server}，答复 ${answer.text}` })
        return (this.lastDns = { server, answer, index: i, internal })
      }
      if (action === 'evaluate' && server) {
        const resp = makeIp(this.truth.realIp, meta.queryType === 'AAAA')
        meta.response = resp
        const ecs = rule.raw.client_subnet ? ` · ECS ${rule.raw.client_subnet}` : ''
        this.push({ ...base, ...snap(), status: 'continue', message: `${m.detail} → 经 ${server}${ecs} 预查询，响应 ${resp.addr}（${ipClassLabel(resp.cls)}），继续匹配` })
        continue
      }
      if (action === 'predefined') {
        const answer: Answer = rule.raw.answer?.length
          ? { kind: 'records', text: `预置答复 ${rule.raw.answer.length} 条` }
          : { kind: 'empty', text: `${rule.raw.rcode ?? 'NOERROR'} 空答复` }
        this.push({ ...base, ...snap(), status: 'hit', message: `${m.detail} → ${answer.text}` })
        return (this.lastDns = { server: null, answer, index: i, internal })
      }
      if (action === 'reject') {
        const answer: Answer = { kind: 'rejected', text: '查询被拒绝' }
        this.push({ ...base, ...snap(), status: 'reject', message: `${m.detail} → reject` })
        return (this.lastDns = { server: null, answer, index: i, internal })
      }
      this.push({ ...base, ...snap(), status: 'continue', message: `${m.detail} → ${action}（非终止），继续` })
    }
    const server = model.dnsFinal.target
    const answer = internal && model.dnsServers[server]?.type === 'fakeip' ? this.realAnswer(meta.queryType) : this.answerFrom(server, meta.queryType)
    this.push({ t: 'rule', stack: 'dns', index: rules.length, status: 'hit', message: `全部未命中 → final ${server}，答复 ${answer.text}`, trace: {}, ...snap() })
    return (this.lastDns = { server, answer, index: rules.length, internal })
  }

  /** 运行业务路由栈，meta 会被嗅探 / resolve 修改。 */
  route(meta: Meta, truth: Truth, subject = "业务连接"): { kind: Outcome['kind']; outbound?: string } {
    const { model } = this
    const snap = () => ({ subject, meta: structuredClone(meta) })
    const rules = model.routeRules
    this.push({ t: 'reset', stack: 'route' })
    for (const rule of rules) {
      const i = rule.index
      const m = this.match(rule, meta, 'route')
      const base = { t: 'rule', stack: 'route', index: i, trace: m.trace } as const
      if (!m.ok) {
        this.push({ ...base, ...snap(), status: 'skip', message: m.detail })
        continue
      }
      const action = rule.raw.action ?? 'route'
      switch (action) {
        case 'route':
          this.push({ ...base, ...snap(), status: 'hit', message: `${m.detail} → ${rule.raw.outbound}` })
          return { kind: 'outbound', outbound: rule.raw.outbound }
        case 'reject':
          this.push({ ...base, ...snap(), status: 'reject', message: `${m.detail} → reject${rule.raw.no_drop ? '（no_drop）' : ''}` })
          return { kind: 'reject' }
        case 'hijack-dns':
          this.push({ ...base, ...snap(), status: 'hit', message: `${m.detail} → hijack-dns，交给 DNS 规则栈` })
          return { kind: 'hijack' }
        case 'bypass':
          this.push({ ...base, ...snap(), status: 'hit', message: `${m.detail} → bypass` })
          return { kind: 'bypass', outbound: rule.raw.outbound }
        case 'sniff': {
          const sniffers: string[] = rule.raw.sniffer ?? DEFAULT_SNIFFERS
          const p = truth.sniffProtocol
          let msg: string
          if (p && sniffers.includes(p)) {
            meta.protocol = p
            msg = `嗅探出 ${p}`
            if (SNIFF_DOMAIN_PROTOCOLS.includes(p) && !meta.domain && truth.domain) {
              meta.domain = truth.domain
              meta.domainSets = truth.domainSets
              msg += `，从 ${p === 'http' ? 'Host' : 'SNI'} 得到域名 ${truth.domain}`
            }
          } else msg = '嗅探超时 / 协议不在嗅探列表，协议未知'
          this.push({ ...base, ...snap(), status: 'continue', message: `${msg}，继续` })
          break
        }
        case 'resolve': {
          if (meta.ip || !meta.domain) {
            this.push({ ...base, ...snap(), status: 'continue', message: meta.ip ? '目标已是 IP，无需解析，继续' : '没有域名，无需解析，继续' })
            break
          }
          this.push({ ...base, ...snap(), status: 'continue', message: 'resolve：调用 DNS 规则栈做内部解析…' })
          this.push({ t: 'phase', text: `↳ 内部解析 ${meta.domain}`, sub: `inbound=${meta.inbound}，不允许 FakeIP` })
          this.push({ t: 'stage', key: 'dns', status: 'active', value: `resolve ${meta.domain}` })
          const v6 = ['prefer_ipv6', 'ipv6_only'].includes(rule.raw.strategy ?? model.dnsStrategy ?? '')
          const dm: Meta = { ...meta, queryType: v6 ? 'AAAA' : 'A', ip: null, protocol: null, network: undefined, port: undefined }
          let res: DnsResult
          if (rule.raw.server) {
            const answer = this.realAnswer(dm.queryType)
            res = this.lastDns = { server: rule.raw.server, answer, index: -1, internal: true }
          } else res = this.dns(dm, true)
          this.stageDns(res)
          meta.ip = res.answer.ip ?? null
          this.push({ ...base, ...snap(), status: 'continue', message: `resolve 完成 → ${res.answer.text}，回到业务路由栈继续` })
          break
        }
        default:
          this.push({ ...base, ...snap(), status: 'continue', message: `${m.detail} → ${action}（非终止），继续` })
      }
    }
    const out = model.routeFinal.target
    this.push({ t: 'rule', stack: 'route', index: rules.length, status: 'hit', message: `全部未命中 → final ${out}`, trace: {}, ...snap() })
    return { kind: 'outbound', outbound: out }
  }

  stageDns(res: DnsResult) {
    const rules = this.model.dnsRules
    this.push({ t: 'stage', key: 'dns', status: 'done', value: res.index < 0 ? '指定服务器' : `命中 ${ruleLabel(rules, res.index)}`, detail: res.internal ? '内部解析' : undefined })
    const bad = ['empty', 'rejected'].includes(res.answer.kind)
    this.push({ t: 'stage', key: 'upstream', status: bad ? 'fail' : 'done', value: res.server ?? '预置答复', detail: `${res.server ? dnsServerDesc(this.model, res.server) + ' → ' : ''}${res.answer.text}` })
  }
}

export function simulate(model: ConfigModel, sc: Scenario): SimResult {
  const inbound = model.inbounds.find((i) => i.tag === sc.inbound)
  const inboundType = inbound?.type ?? 'unknown'
  const tgt = sc.target
  const targetName = tgt.kind === 'domain' ? tgt.domain : makeIp(tgt.cls).addr
  const truth: Truth =
    tgt.kind === 'domain'
      ? { domain: tgt.domain, domainSets: tgt.sets, realIp: tgt.realIp, sniffProtocol: sc.conn.protocol }
      : { domain: null, domainSets: [], realIp: tgt.cls, sniffProtocol: sc.conn.protocol }
  const R = new Runner(model, truth)
  const base = (): Meta => ({
    inbound: sc.inbound, inboundType, processName: sc.process.name, processPath: sc.process.path,
    clashMode: sc.mode, domain: null, domainSets: [], ip: null, protocol: null,
  })
  const finish = (o: Omit<Outcome, 'target'>): SimResult => ({ steps: R.steps, outcome: { ...o, target: targetName } })

  R.push({ t: 'stage', key: 'entry', status: 'done', value: sc.inbound, detail: `${inboundType} · ${sc.process.label ?? sc.process.name ?? '未知进程'} · ${sc.mode}` })

  const conn = base()
  if (tgt.kind === 'domain' && inboundType === 'tun') {
    /* ① 应用自行发起 DNS 查询，DNS 包先过业务路由栈 */
    R.push({ t: 'phase', text: `① 应用查询 ${tgt.domain} 的 ${sc.queryType} 记录`, sub: 'DNS 包 UDP/53 进入 TUN，先经过业务路由栈' })
    R.push({ t: 'stage', key: 'dns', status: 'active', value: `${sc.queryType} ${tgt.domain}` })
    const keep = sc.dnsKeepsProcess
    const pkt: Meta = { ...base(), processName: keep ? sc.process.name : null, processPath: keep ? sc.process.path : null, network: 'udp', port: 53, ip: makeIp('private') }
    pkt.ip!.addr = '172.19.0.2'
    const pktRes = R.route(pkt, { domain: null, domainSets: [], realIp: 'private', sniffProtocol: 'dns' }, 'DNS 查询包')
    let res: DnsResult
    if (pktRes.kind === 'hijack') {
      R.push({ t: 'phase', text: 'DNS 规则栈', sub: keep ? '查询携带进程身份' : '系统 DNS 代发：进程身份丢失' })
      res = R.dns({ ...base(), processName: pkt.processName, processPath: pkt.processPath, queryType: sc.queryType, domain: tgt.domain, domainSets: tgt.sets }, false)
    } else {
      R.push({ t: 'note', level: 'warn', text: 'DNS 包没有被 hijack-dns 劫持，按普通解析处理' })
      res = { server: null, answer: R.realAnswer(sc.queryType), index: -1, internal: false }
    }
    R.stageDns(res)
    if (res.answer.kind !== 'fake' && res.answer.kind !== 'real') {
      const text = res.answer.kind === 'records' ? '非地址记录，不产生业务连接。' : '没有可用地址，应用会改用 A 记录或放弃该地址族。'
      R.push({ t: 'note', level: 'info', text })
      R.push({ t: 'stage', key: 'route', status: 'skip', value: '无业务连接' })
      R.push({ t: 'stage', key: 'outbound', status: 'skip', value: '—' })
      return finish({ kind: 'dns-only', dns: res, reason: text })
    }
    if (res.answer.kind === 'fake') {
      conn.domain = tgt.domain
      conn.domainSets = tgt.sets
      R.push({ t: 'note', level: 'info', text: `应用连接 ${res.answer.ip!.addr} → 从 FakeIP 映射恢复域名 ${tgt.domain}` })
    } else {
      conn.ip = res.answer.ip!
      R.push({ t: 'note', level: 'info', text: `应用直连真实 IP ${res.answer.ip!.addr}，路由此时只看得到 IP` })
    }
  } else if (tgt.kind === 'domain') {
    conn.domain = tgt.domain
    conn.domainSets = tgt.sets
    R.push({ t: 'stage', key: 'dns', status: 'skip', value: '客户端只交域名', detail: '显式代理入口不经过应用 DNS' })
    R.push({ t: 'stage', key: 'upstream', status: 'skip', value: '—' })
  } else {
    conn.ip = makeIp(tgt.cls)
    R.push({ t: 'stage', key: 'dns', status: 'skip', value: '目标是 IP，无 DNS' })
    R.push({ t: 'stage', key: 'upstream', status: 'skip', value: '—' })
  }

  /* ② 业务连接 */
  conn.network = sc.conn.network
  conn.port = sc.conn.port
  R.push({ t: 'phase', text: `② 业务连接 ${sc.conn.network.toUpperCase()}/${sc.conn.port} → 业务路由栈`, sub: `目标 ${conn.domain ?? conn.ip?.addr}` })
  R.push({ t: 'stage', key: 'route', status: 'active', value: '匹配中…' })
  const rr = R.route(conn, truth)
  const routeIdx = [...R.steps].reverse().find((s) => s.t === 'rule' && s.stack === 'route' && s.status !== 'skip' && s.status !== 'continue')
  const hitLabel = routeIdx && routeIdx.t === 'rule' ? ruleLabel(model.routeRules, routeIdx.index) : ''
  const dns = R.lastDns
  if (rr.kind === 'outbound' || rr.kind === 'bypass') {
    const chain = outboundChain(model, rr.outbound ?? 'direct')
    R.push({ t: 'stage', key: 'route', status: 'done', value: `${hitLabel} → ${rr.outbound}` })
    R.push({ t: 'stage', key: 'outbound', status: 'done', value: [...chain.select.map((h) => h.tag), chain.hops.at(-1)?.tag].filter(Boolean).join(' › '), detail: chain.hops.map((h) => h.tag).join(' → ') })
    return finish({ kind: rr.kind, outbound: rr.outbound, chain, dns, meta: conn })
  }
  R.push({ t: 'stage', key: 'route', status: rr.kind === 'reject' ? 'fail' : 'done', value: `${hitLabel} → ${rr.kind}` })
  R.push({ t: 'stage', key: 'outbound', status: rr.kind === 'reject' ? 'fail' : 'done', value: rr.kind === 'reject' ? '连接被拒绝' : 'DNS 模块' })
  return finish({ kind: rr.kind, dns, meta: conn })
}
