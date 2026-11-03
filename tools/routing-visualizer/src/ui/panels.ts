import type { ConfigModel } from '../config/types'
import { ipClassLabel } from '../engine/ip'
import { dnsServerDesc } from '../engine/outbound'
import { ruleLabel } from '../engine/simulate'
import type { Hop, Meta, Outcome, Stack } from '../engine/types'
import { clear, h } from './dom'
import { STAGES, type ConnView, type LogItem, type ViewState } from './viewState'

/* ---------- 顶部流水线 ---------- */
export class PipelineView {
  readonly root = h('ol', { class: 'pipeline' })
  private items = STAGES.map((s, i) => {
    const value = h('div', { class: 'st-value' }, '—')
    const detail = h('div', { class: 'st-detail' })
    const li = h('li', { class: 'stage', dataset: { status: 'idle' } },
      h('div', { class: 'st-num' }, String(i + 1)),
      h('div', { class: 'st-body' }, h('div', { class: 'st-title' }, s.title), value, detail),
    )
    this.root.append(li)
    return { key: s.key, li, value, detail }
  })

  update(v: ViewState) {
    for (const it of this.items) {
      const st = v.stages[it.key]
      it.li.dataset.status = st.status
      it.value.textContent = st.value
      it.detail.textContent = st.detail ?? ''
      it.detail.title = st.detail ?? ''
    }
  }
}

/* ---------- 结果卡 ---------- */
const OUT_CLASS: Record<string, string> = { claude: 'violet', direct: 'green', proxy: 'blue' }

function hopNode(hop: Hop, kind: 'hop' | 'end' = 'hop') {
  return h('li', { class: `hop hop-${kind}` }, h('span', { class: 'hop-tag' }, hop.tag), h('span', { class: 'hop-desc' }, hop.desc))
}

export function renderResult(root: HTMLElement, model: ConfigModel, o: Outcome | null, finished: boolean) {
  if (!o || !finished) {
    clear(root, h('div', { class: 'result-empty' }, finished ? '' : '播放结束后在这里显示最终结果'))
    root.dataset.kind = ''
    return
  }
  root.dataset.kind = o.kind
  const facts: [string, string][] = []
  if (o.dns) {
    const label = o.dns.index < 0 ? '指定服务器' : ruleLabel(model.dnsRules, o.dns.index)
    facts.push(['DNS', `${label} → ${o.dns.server ?? '预置答复'}${o.dns.internal ? '（内部解析）' : ''}`])
    if (o.dns.server) facts.push(['上游', dnsServerDesc(model, o.dns.server)])
    facts.push(['答复', o.dns.answer.text])
  }
  if (o.meta) {
    facts.push(['嗅探', o.meta.protocol ?? '未嗅探 / 未知'])
    facts.push(['匹配依据', `域名 ${o.meta.domain ?? '无'} · IP ${o.meta.ip ? `${o.meta.ip.addr}（${ipClassLabel(o.meta.ip.cls)}）` : '无'}`])
  }

  let headline: HTMLElement
  let chain: HTMLElement | null = null
  if (o.kind === 'outbound' || o.kind === 'bypass') {
    const tone = OUT_CLASS[String(o.outbound).toLowerCase()] ?? 'blue'
    headline = h('div', { class: `headline tone-${tone}` }, h('span', { class: 'hl-k' }, '最终出站'), h('span', { class: 'hl-v' }, o.outbound))
    const c = o.chain!
    const target: Hop = { tag: o.target, type: 'target', desc: o.meta?.domain && !o.meta.ip ? (c.hops.at(-1)?.type === 'direct' ? `本机经 ${c.resolver ?? '默认解析器'} 解析` : '域名交给远端解析') : '目标地址' }
    chain = h('div', { class: 'chain' },
      c.select.length > 0 && h('div', { class: 'chain-select' },
        h('span', { class: 'chain-k' }, '选择器'),
        c.select.map((s) => [h('span', { class: 'sel-tag', title: s.desc }, s.tag), h('span', { class: 'arr' }, '›')]),
        h('span', { class: 'sel-tag on' }, c.hops.at(-1)?.tag),
      ),
      h('ol', { class: 'chain-v' },
        hopNode({ tag: '本机', type: 'local', desc: `入口 ${o.meta?.inbound ?? ''}` }, 'end'),
        c.hops.map((hp, i) => hopNode({ ...hp, desc: `${hp.desc}${i < c.hops.length - 1 ? ' · 前置' : ''}` })),
        hopNode(target, 'end'),
      ),
    )
  } else if (o.kind === 'reject') {
    headline = h('div', { class: 'headline tone-red' }, h('span', { class: 'hl-k' }, '结果'), h('span', { class: 'hl-v' }, 'REJECT'))
  } else if (o.kind === 'hijack') {
    headline = h('div', { class: 'headline tone-violet' }, h('span', { class: 'hl-k' }, '结果'), h('span', { class: 'hl-v' }, 'hijack-dns'))
  } else {
    headline = h('div', { class: 'headline tone-violet' }, h('span', { class: 'hl-k' }, 'DNS 答复'), h('span', { class: 'hl-v small' }, o.dns?.answer.text ?? '—'))
  }
  clear(root, headline, chain, o.reason && h('p', { class: 'reason' }, o.reason),
    h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])))
}

/* ---------- 连接状态（元数据） ---------- */
type Row = { key: string; label: string; get: (m: Meta) => string; scope?: 'dns' | 'route' }
const EMPTY = '—'
const ROWS: Row[] = [
  { key: 'inbound', label: 'inbound', get: (m) => `${m.inbound} · ${m.inboundType}` },
  { key: 'process', label: '进程名', get: (m) => m.processName ?? '未识别' },
  { key: 'path', label: '进程路径', get: (m) => m.processPath ?? EMPTY },
  { key: 'mode', label: 'clash_mode', get: (m) => m.clashMode },
  { key: 'qtype', label: 'query_type', get: (m) => m.queryType ?? EMPTY, scope: 'dns' },
  { key: 'net', label: 'network / 端口', get: (m) => (m.network ? `${m.network.toUpperCase()} / ${m.port}` : EMPTY), scope: 'route' },
  { key: 'domain', label: '目标域名', get: (m) => m.domain ?? EMPTY },
  { key: 'dsets', label: '域名规则集', get: (m) => (m.domain ? m.domainSets.join(', ') || '（无）' : EMPTY) },
  { key: 'ip', label: '目标 IP', get: (m) => (m.ip ? `${m.ip.addr} · ${ipClassLabel(m.ip.cls)}` : EMPTY), scope: 'route' },
  { key: 'isets', label: 'IP 规则集', get: (m) => (m.ip ? m.ip.sets.join(', ') || '（无）' : EMPTY), scope: 'route' },
  { key: 'proto', label: 'protocol', get: (m) => m.protocol ?? '未知', scope: 'route' },
  { key: 'resp', label: 'DNS 响应', get: (m) => (m.response ? `${m.response.addr} · ${ipClassLabel(m.response.cls)}` : EMPTY), scope: 'dns' },
]

export function renderConn(root: HTMLElement, model: ConfigModel, c: ConnView | undefined) {
  if (!c) {
    clear(root, h('div', { class: 'result-empty' }, '开始播放后，这里实时显示被路由对象的元数据'))
    return
  }
  const rules = c.stack === 'dns' ? model.dnsRules : model.routeRules
  const label = ruleLabel(rules, c.index)
  const rows = ROWS.filter((r) => !r.scope || r.scope === c.stack)
  const changed = c.prev ? rows.filter((r) => r.get(c.meta) !== r.get(c.prev!)).length : 0
  clear(root,
    h('div', { class: 'conn-head' },
      h('span', { class: `conn-subj subj-${c.stack}` }, c.subject),
      c.prev
        ? h('span', { class: 'muted' }, changed ? `${c.stack === 'dns' ? 'DNS' : 'RT'} ${label} 更新了 ${changed} 项` : `${c.stack === 'dns' ? 'DNS' : 'RT'} ${label} · 无变化`)
        : h('span', { class: 'muted' }, '新对象进入规则栈'),
    ),
    h('dl', { class: 'conn' }, rows.map((r) => {
      const now = r.get(c.meta)
      const before = c.prev ? r.get(c.prev) : now
      const diff = now !== before
      return [
        h('dt', { class: diff ? 'changed' : '' }, r.label),
        h('dd', { class: `${diff ? 'changed' : ''}${now === EMPTY ? ' empty' : ''}`, title: now },
          diff && h('s', { class: 'old' }, before), diff && h('span', { class: 'arr' }, ' → '), now),
      ]
    })),
  )
}

/* ---------- 执行流水 ---------- */
export function renderLog(root: HTMLElement, items: LogItem[], model: ConfigModel, onPick: (stack: Stack, index: number) => void) {
  const rules = (s: Stack) => (s === 'dns' ? model.dnsRules : model.routeRules)
  clear(root, items.length === 0 && h('div', { class: 'log-empty' }, '按 ▶ 开始，或用 ← → 单步'),
    items.map((it, n) => {
      if (it.kind === 'phase') return h('div', { class: 'lg lg-phase' }, h('div', { class: 'lg-t' }, it.text), it.sub && h('div', { class: 'lg-sub' }, it.sub))
      if (it.kind === 'note') return h('div', { class: `lg lg-note ${it.level}` }, h('span', { class: 'lg-dot' }), h('span', null, it.text))
      const last = n === items.length - 1
      return h('div', { class: `lg lg-rule${last ? ' last' : ''}`, dataset: { status: it.status }, onclick: () => onPick(it.stack!, it.index!) },
        h('span', { class: 'lg-dot' }),
        h('span', { class: `lg-tag tag-${it.stack}` }, `${it.stack === 'dns' ? 'DNS' : 'RT'} ${ruleLabel(rules(it.stack!), it.index!)}`),
        h('span', { class: 'lg-msg' }, it.text),
      )
    }))
  root.scrollTop = root.scrollHeight
}
