import type { ConfigModel } from '../config/types'
import { IP_CLASSES } from '../engine/ip'
import type { IpClass } from '../engine/types'
import { CONNS, MODES, PRESETS, PROCESSES, QUERY_TYPES, TARGETS, type Preset, type ScenarioInput } from '../scenario/catalog'
import { clear, h, segmented, select } from './dom'

export interface SidebarHandlers {
  onInput(input: ScenarioInput): void
  onPreset(p: Preset): void
}

export class Sidebar {
  readonly root = h('aside', { class: 'sidebar' })
  private presetsEl = h('div', { class: 'presets' })
  private formEl = h('div', { class: 'form' })
  private activePreset?: string
  private filter = ''

  constructor(
    private model: ConfigModel,
    private input: ScenarioInput,
    private handlers: SidebarHandlers,
  ) {
    const search = h('input', {
      class: 'search', type: 'search', placeholder: '搜索场景…',
      oninput: (e: Event) => {
        this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase()
        this.renderPresets()
      },
    })
    this.root.append(
      h('section', { class: 'panel' }, h('h3', null, '场景预设'), search, this.presetsEl),
      h('section', { class: 'panel' }, h('h3', null, '场景参数'), this.formEl),
    )
    this.renderPresets()
    this.renderForm()
  }

  setModel(model: ConfigModel) {
    this.model = model
    this.renderForm()
  }

  setInput(input: ScenarioInput, presetId?: string) {
    this.input = input
    this.activePreset = presetId
    this.renderPresets()
    this.renderForm()
  }

  private renderPresets() {
    const groups = new Map<string, Preset[]>()
    for (const p of PRESETS) {
      if (this.filter && !`${p.group} ${p.title}`.toLowerCase().includes(this.filter)) continue
      groups.set(p.group, [...(groups.get(p.group) ?? []), p])
    }
    clear(this.presetsEl,
      groups.size === 0 && h('div', { class: 'muted' }, '没有匹配的场景'),
      [...groups].map(([g, ps]) =>
        h('div', { class: 'pgroup' },
          h('div', { class: 'pgroup-t' }, g),
          ps.map((p) => h('button', {
            type: 'button', class: `preset${p.id === this.activePreset ? ' on' : ''}`, onclick: () => this.handlers.onPreset(p),
          }, h('span', null, p.title), h('span', { class: `pexp exp-${(p.expect.outbound ?? p.expect.kind).toLowerCase()}` }, p.expect.outbound ?? (p.expect.kind === 'dns-only' ? 'DNS' : p.expect.kind)))),
        )),
    )
  }

  private set(patch: Partial<ScenarioInput>) {
    this.input = { ...this.input, ...patch }
    this.activePreset = undefined
    this.renderPresets()
    this.renderForm()
    this.handlers.onInput(this.input)
  }

  private renderForm() {
    const i = this.input
    const m = this.model
    const t = TARGETS.find((x) => x.id === i.targetId) ?? TARGETS[0]
    const isDomain = !t.ipClass
    const sets = i.sets ?? t.sets ?? []
    const realIp = i.realIp ?? t.realIp ?? 'foreign'
    const inbound = m.inbounds.find((x) => x.tag === i.inbound)
    const isTun = inbound?.type === 'tun'
    const domainSets = m.ruleSets.filter((r) => r.kind === 'domain')
    const field = (label: string, ...ctl: any[]) => h('div', { class: 'field' }, h('label', null, label), h('div', { class: 'ctl' }, ...ctl))

    clear(this.formEl,
      field('模式', segmented(MODES.map((x) => ({ value: x, label: x })), i.mode, (v) => this.set({ mode: v }))),
      field('入口', select(m.inbounds.map((x) => ({ value: x.tag, label: `${x.tag} · ${x.type}${x.port ? ' :' + x.port : ''}`, title: x.note })), i.inbound, (v) => this.set({ inbound: v }))),
      field('进程', select(PROCESSES.map((p) => ({ value: p.id, label: p.label, title: p.path ?? '' })), i.processId, (v) => this.set({ processId: v }))),
      field('', h('label', { class: 'check', title: '系统 DNS 代发（如 Windows DNS Client）时，DNS 查询看不到原进程' },
        h('input', { type: 'checkbox', checked: i.dnsKeepsProcess, disabled: !isTun, onchange: (e: Event) => this.set({ dnsKeepsProcess: (e.target as HTMLInputElement).checked }) }),
        'DNS 查询可识别进程')),
      field('目标', select(TARGETS.map((x) => ({ value: x.id, label: x.label, group: x.ipClass ? '裸 IP' : '域名', title: x.hint })), i.targetId,
        (v) => this.set({ targetId: v, sets: undefined, realIp: undefined }))),
      t.id === 'custom' && field('域名', h('input', {
        type: 'text', value: i.customDomain ?? t.domain, spellcheck: 'false',
        onchange: (e: Event) => this.set({ customDomain: (e.target as HTMLInputElement).value }),
      })),
      field('记录类型', segmented(QUERY_TYPES.map((x) => ({ value: x, label: x })), i.queryType, (v) => this.set({ queryType: v }))),
      field('连接', select(CONNS.map((c) => ({ value: c.id, label: c.label })), i.connId, (v) => this.set({ connId: v }))),
      isDomain && h('div', { class: 'sub-panel' },
        h('div', { class: 'sub-t' }, '目标域名属于的规则集', t.hint && h('span', { class: 'muted' }, ` · ${t.hint}`)),
        h('div', { class: 'tags' }, domainSets.map((rs) => {
          const on = sets.includes(rs.tag)
          return h('button', {
            type: 'button', class: `tagbtn${on ? ' on' : ''}`, title: rs.url,
            onclick: () => this.set({ sets: on ? sets.filter((s) => s !== rs.tag) : [...sets, rs.tag] }),
          }, rs.tag)
        })),
        h('div', { class: 'sub-t' }, '真实解析结果'),
        segmented((['cn', 'foreign', 'private'] as IpClass[]).map((c) => ({ value: c, label: IP_CLASSES[c].label })), realIp, (v) => this.set({ realIp: v })),
      ),
    )
  }
}
