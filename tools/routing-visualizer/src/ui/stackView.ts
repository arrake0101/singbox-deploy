import type { ConfigModel, FinalEntry, RuleEntry } from '../config/types'
import { actionOptions, leafLabel, type CondNode } from '../engine/conditions'
import { dnsServerDesc } from '../engine/outbound'
import { condOf } from '../engine/simulate'
import type { Stack } from '../engine/types'
import { h } from './dom'
import type { CardView } from './viewState'

interface CardRef {
  el: HTMLElement
  why: HTMLElement
  chips: Map<string, HTMLElement>
}

const STATUS_ICON = { skip: '✕', continue: '↻', hit: '✓', reject: '⛔' } as const
const STATUS_TEXT = { skip: '未命中', continue: '继续', hit: '命中', reject: '拒绝' } as const

function firstSentence(note?: string): string | undefined {
  if (!note) return undefined
  const s = note.split(/[；。\n]/)[0].trim()
  return s.length > 46 ? s.slice(0, 45) + '…' : s
}

function actionPill(stack: Stack, raw: Record<string, any>, model: ConfigModel): HTMLElement {
  const a = raw.action ?? 'route'
  if (a === 'route') {
    if (stack === 'dns') return h('span', { class: 'pill pill-dns', title: dnsServerDesc(model, raw.server) }, '→ ', raw.server)
    return h('span', { class: `pill pill-out out-${String(raw.outbound).toLowerCase()}` }, '→ ', raw.outbound)
  }
  if (a === 'reject') return h('span', { class: 'pill pill-reject' }, 'reject')
  if (a === 'predefined') return h('span', { class: 'pill pill-reject' }, `predefined ${raw.rcode ?? ''}`.trim())
  if (a === 'hijack-dns') return h('span', { class: 'pill pill-dns' }, 'hijack-dns')
  return h('span', { class: 'pill pill-cont', title: '非终止动作：执行后继续匹配后续规则' }, a, raw.server ? ` · ${raw.server}` : '')
}

function fmtOpt(v: any) {
  if (Array.isArray(v)) return v.length ? v.join(',') : '[]'
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** 没有注释时，用动作生成一句说明。 */
function autoSummary(stack: Stack, raw: Record<string, any>): string {
  const a = raw.action ?? 'route'
  switch (a) {
    case 'route':
      return stack === 'dns' ? `交给 ${raw.server} 解析` : `走 ${raw.outbound} 出站`
    case 'predefined':
      return `直接返回 ${raw.rcode ?? 'NOERROR'}${raw.answer?.length ? ' 预置答复' : ' 空答复'}`
    case 'evaluate':
      return `经 ${raw.server} 预查询，结果交给后续规则`
    case 'reject':
      return stack === 'dns' ? '拒绝查询' : '拒绝连接'
    case 'sniff':
      return '协议嗅探'
    case 'hijack-dns':
      return '劫持 DNS 流量到 DNS 模块'
    case 'resolve':
      return '把目标域名解析成 IP'
    default:
      return a
  }
}

export class StackView {
  private refs = new Map<number, CardRef>()
  readonly root: HTMLElement

  constructor(
    readonly stack: Stack,
    private model: ConfigModel,
  ) {
    this.root = h('div', { class: 'stack' })
    this.build()
  }

  private get rules(): RuleEntry[] {
    return this.stack === 'dns' ? this.model.dnsRules : this.model.routeRules
  }
  private get final(): FinalEntry {
    return this.stack === 'dns' ? this.model.dnsFinal : this.model.routeFinal
  }

  private build() {
    const rules = this.rules
    rules.forEach((r) => {
      for (const s of r.sections) {
        if (s.kind === 'text') this.root.append(h('div', { class: 'divider' }, h('span', null, s.text)))
        else this.root.append(h('div', { class: 'ghost', title: '配置中已注释的规则，不参与匹配' }, h('div', { class: 'ghost-label' }, '已注释的规则'), h('code', null, s.text)))
      }
      this.root.append(this.card(r.index, r.tag, r.raw, r.note, condOf(r)))
    })
    const f = this.final
    const finalRaw = this.stack === 'dns' ? { final: f.target, strategy: this.model.dnsStrategy } : { final: f.target, default_domain_resolver: this.model.defaultDomainResolver }
    this.root.append(this.card(rules.length, f.tag ?? 'final', finalRaw, f.note, null, f.target))
  }

  private card(index: number, tag: string | undefined, raw: Record<string, any>, note: string | undefined, cond: CondNode | null, finalTarget?: string): HTMLElement {
    const chips = new Map<string, HTMLElement>()
    const isFinal = finalTarget !== undefined
    const opts = isFinal ? [] : actionOptions(raw)
    const why = h('div', { class: 'why' })
    const fromNote = firstSentence(note)
    const summary = fromNote ?? (isFinal ? '以上规则全部未命中时使用' : autoSummary(this.stack, raw))
    const pill = isFinal
      ? h('span', { class: 'pill pill-final', title: this.stack === 'dns' ? dnsServerDesc(this.model, finalTarget) : undefined }, 'final → ', finalTarget)
      : actionPill(this.stack, raw, this.model)

    const el = h('article', { class: `card${isFinal ? ' final' : ''}`, dataset: { index: String(index) }, tabindex: '0' },
      h('div', { class: 'rail' }, h('span', { class: 'idx' }, isFinal ? 'F' : String(index + 1).padStart(2, '0'))),
      h('div', { class: 'body' },
        h('header', { class: 'head', onclick: () => el.classList.toggle('open') },
          tag && h('span', { class: 'rtag' }, tag),
          h('span', { class: `summary${fromNote ? '' : ' auto'}`, title: note }, summary),
          pill,
        ),
        cond && h('div', { class: 'conds' }, this.renderCond(cond, chips, true)),
        opts.length > 0 && h('div', { class: 'opts' }, opts.map(([k, v]) => h('span', { class: 'opt' }, `${k}: ${fmtOpt(v)}`))),
        why,
        h('div', { class: 'more' },
          note && h('p', { class: 'note' }, note),
          h('pre', { class: 'json' }, JSON.stringify(raw, null, 2)),
        ),
      ),
    )
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.classList.toggle('open')
    })
    this.refs.set(index, { el, why, chips })
    return el
  }

  private renderCond(node: CondNode, chips: Map<string, HTMLElement>, top = false): HTMLElement {
    if (node.kind === 'leaf') {
      const { text, title } = leafLabel(node)
      const chip = h('span', { class: 'chip', title }, node.invert && h('b', { class: 'not' }, 'NOT '), text)
      chips.set(node.id, chip)
      return chip
    }
    const kids = node.children ?? []
    const parts: (HTMLElement | string)[] = []
    kids.forEach((c, i) => {
      if (i) parts.push(h('span', { class: `op op-${node.kind}` }, node.kind.toUpperCase()))
      parts.push(this.renderCond(c, chips))
    })
    const grp = h('span', { class: `grp${top && !node.invert ? ' top' : ''}${node.implicit ? ' implicit' : ''}` },
      node.invert && h('b', { class: 'not' }, 'NOT'),
      !(top && !node.invert) && h('span', { class: 'paren' }, '('),
      parts,
      !(top && !node.invert) && h('span', { class: 'paren' }, ')'),
    )
    chips.set(node.id, grp)
    return grp
  }

  update(view: Map<number, CardView>, current?: number) {
    for (const [i, ref] of this.refs) {
      const cv = view.get(i)
      ref.el.dataset.status = cv?.status ?? ''
      ref.el.classList.toggle('current', current === i)
      ref.why.replaceChildren()
      if (cv) ref.why.append(h('span', { class: 'why-ic' }, STATUS_ICON[cv.status]), h('span', { class: 'why-st' }, STATUS_TEXT[cv.status]), cv.message)
      for (const [id, chip] of ref.chips) {
        const r = cv?.trace[id]
        chip.dataset.ok = r ? String(r.ok) : ''
        if (r) chip.setAttribute('data-detail', r.detail)
        else chip.removeAttribute('data-detail')
      }
    }
  }

  focus(index: number, smooth = true) {
    const ref = this.refs.get(index)
    if (!ref) return
    ref.el.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }

  flash(index: number) {
    const ref = this.refs.get(index)
    if (!ref) return
    ref.el.classList.add('open', 'flash')
    ref.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setTimeout(() => ref.el.classList.remove('flash'), 1200)
  }
}
