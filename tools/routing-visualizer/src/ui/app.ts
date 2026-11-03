import { ConfigError, parseConfig } from '../config/parse'
import type { ConfigModel } from '../config/types'
import { simulate } from '../engine/simulate'
import type { SimResult, Stack } from '../engine/types'
import { DEFAULT_INPUT, PRESETS, presetInput, toScenario, type ScenarioInput } from '../scenario/catalog'
import { clear, h, toast } from './dom'
import { PipelineView, renderConn, renderLog, renderResult } from './panels'
import { Sidebar } from './sidebar'
import { StackView } from './stackView'
import { computeView, frameEnds } from './viewState'

const SPEEDS = [0.5, 1, 2, 4]
const BASE_INTERVAL = 650

export class App {
  private model: ConfigModel
  private input: ScenarioInput
  private sim!: SimResult
  private frames: number[] = []
  private pos = 0
  private timer: number | null = null
  private speed = 1

  private sidebar: Sidebar
  private pipeline = new PipelineView()
  private stacks!: Record<Stack, StackView>
  private els = {
    configName: h('span', { class: 'cfg-name' }),
    stats: h('span', { class: 'cfg-stats' }),
    dnsCol: h('div', { class: 'col-body' }),
    routeCol: h('div', { class: 'col-body' }),
    result: h('div', { class: 'result' }),
    conn: h('div', { class: 'conn-body' }),
    log: h('div', { class: 'log' }),
    play: h('button', { type: 'button', class: 'btn primary', title: '播放 / 暂停（空格）' }),
    scrub: h('input', { type: 'range', class: 'scrub', min: '0', value: '0', 'aria-label': '执行进度' }) as HTMLInputElement,
    counter: h('span', { class: 'counter mono' }),
    file: h('input', { type: 'file', accept: '.json,.jsonc,application/json', hidden: true }) as HTMLInputElement,
  }

  constructor(
    private mount: HTMLElement,
    private defaultText: string,
    private defaultName: string,
  ) {
    this.model = parseConfig(defaultText, defaultName)
    this.input = { ...DEFAULT_INPUT, inbound: this.model.inbounds[0]?.tag ?? DEFAULT_INPUT.inbound, mode: this.model.defaultMode }
    this.sidebar = new Sidebar(this.model, this.input, {
      onInput: (inp) => {
        this.input = inp
        this.presetId = undefined
        this.recompute(false)
      },
      onPreset: (p) => {
        this.presetId = p.id
        this.input = presetInput(p)
        this.sidebar.setInput(this.input, p.id)
        this.recompute(true)
      },
    })
    // 深链接：#p=<预设 id>&step=<帧号>（必须在首次渲染改写 hash 之前读取）
    const hash = new URLSearchParams(location.hash.slice(1))
    this.layout()
    this.setModel(this.model)
    const first = PRESETS.find((p) => p.id === hash.get('p')) ?? PRESETS[0]
    this.presetId = first.id
    this.input = presetInput(first)
    this.sidebar.setInput(this.input, first.id)
    this.recompute(false)
    const step = hash.get('step')
    if (step !== null) this.seek(Number(step))
    this.bindKeys()
  }

  private presetId?: string

  private syncHash() {
    if (!this.presetId) return history.replaceState(null, '', location.pathname + location.search)
    const step = this.pos < this.frames.length ? `&step=${this.pos}` : ''
    history.replaceState(null, '', `#p=${this.presetId}${step}`)
  }

  /* ---------- 布局 ---------- */
  private layout() {
    const e = this.els
    e.file.addEventListener('change', () => {
      const f = e.file.files?.[0]
      if (f) void this.loadFile(f)
      e.file.value = ''
    })
    e.play.addEventListener('click', () => this.toggle())
    e.scrub.addEventListener('input', () => {
      this.pause()
      this.seek(Number(e.scrub.value))
    })
    const speedSel = h('select', { class: 'speed', title: '播放速度', onchange: (ev: Event) => (this.speed = Number((ev.target as HTMLSelectElement).value)) },
      SPEEDS.map((s) => h('option', { value: String(s), selected: s === 1 }, `${s}×`)))
    const toggle = (cls: string, label: string, title: string) =>
      h('label', { class: 'check', title }, h('input', { type: 'checkbox', onchange: (ev: Event) => document.body.classList.toggle(cls, (ev.target as HTMLInputElement).checked) }), label)

    clear(this.mount,
      h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'logo' }, '⇶'), h('div', null, h('div', { class: 'title' }, 'sing-box 路由流水栈'), h('div', { class: 'subtitle' }, 'DNS 规则栈 · 业务路由栈 · 出站链路'))),
        h('div', { class: 'cfg' }, h('span', { class: 'cfg-ic' }, '{ }'), e.configName, e.stats),
        h('div', { class: 'top-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => e.file.click(), title: '也可以把配置文件拖进窗口' }, '载入配置…'),
          h('button', { type: 'button', class: 'btn ghost', onclick: () => this.setModel(parseConfig(this.defaultText, this.defaultName)) }, '恢复模板'),
          e.file,
        ),
      ),
      h('div', { class: 'shell' },
        this.sidebar.root,
        h('main', { class: 'main' },
          h('section', { class: 'panel pipe-panel' }, this.pipeline.root),
          h('div', { class: 'player' },
            h('div', { class: 'pl-btns' },
              h('button', { type: 'button', class: 'btn icon', title: '回到开头（Home）', onclick: () => (this.pause(), this.seek(0)) }, '⏮'),
              h('button', { type: 'button', class: 'btn icon', title: '上一步（←）', onclick: () => (this.pause(), this.seek(this.pos - 1)) }, '◀'),
              e.play,
              h('button', { type: 'button', class: 'btn icon', title: '下一步（→）', onclick: () => (this.pause(), this.seek(this.pos + 1)) }, '▶'),
              h('button', { type: 'button', class: 'btn icon', title: '跳到结果（End）', onclick: () => (this.pause(), this.seek(this.frames.length)) }, '⏭'),
            ),
            e.scrub, e.counter, speedSel,
            h('div', { class: 'pl-opts' },
              toggle('hide-skip', '隐藏未命中', '只显示参与了本次匹配的规则'),
              toggle('expand-all', '展开说明', '展开所有规则的注释和 JSON'),
            ),
          ),
          h('div', { class: 'cols' },
            h('section', { class: 'panel col' }, h('div', { class: 'col-head' }, h('h2', null, 'DNS 规则栈'), h('span', { class: 'muted mono' }, 'dns.rules')), e.dnsCol),
            h('section', { class: 'panel col' }, h('div', { class: 'col-head' }, h('h2', null, '业务路由栈'), h('span', { class: 'muted mono' }, 'route.rules')), e.routeCol),
            h('section', { class: 'col side' },
              h('div', { class: 'panel' }, h('div', { class: 'col-head' }, h('h2', null, '连接状态'), h('span', { class: 'muted' }, '规则匹配看到的元数据')), e.conn),
              h('div', { class: 'panel' }, h('div', { class: 'col-head' }, h('h2', null, '结果')), e.result),
              h('div', { class: 'panel log-panel' }, h('div', { class: 'col-head' }, h('h2', null, '执行流水'), h('span', { class: 'muted' }, '点击条目定位规则')), e.log),
            ),
          ),
        ),
      ),
    )

    // 拖入配置文件
    window.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      document.body.classList.add('dragging')
    })
    window.addEventListener('dragleave', (ev) => {
      if (!ev.relatedTarget) document.body.classList.remove('dragging')
    })
    window.addEventListener('drop', (ev) => {
      ev.preventDefault()
      document.body.classList.remove('dragging')
      const f = ev.dataTransfer?.files?.[0]
      if (f) void this.loadFile(f)
    })
  }

  private async loadFile(f: File) {
    try {
      this.setModel(parseConfig(await f.text(), f.name))
      toast(`已载入 ${f.name}`)
    } catch (err) {
      toast(err instanceof ConfigError ? err.message : `载入失败：${String(err)}`, 'error')
    }
  }

  setModel(model: ConfigModel) {
    this.model = model
    this.els.configName.textContent = model.name
    this.els.configName.title = model.header ?? ''
    this.els.stats.textContent = `DNS ${model.dnsRules.length} 条 · 路由 ${model.routeRules.length} 条 · 规则集 ${model.ruleSets.length}`
    this.stacks = { dns: new StackView('dns', model), route: new StackView('route', model) }
    clear(this.els.dnsCol, this.stacks.dns.root)
    clear(this.els.routeCol, this.stacks.route.root)
    this.sidebar.setModel(model)
    this.recompute(false)
  }

  /* ---------- 模拟与播放 ---------- */
  private recompute(autoplay: boolean) {
    this.pause()
    this.sim = simulate(this.model, toScenario(this.input, this.model))
    this.frames = frameEnds(this.sim.steps)
    this.els.scrub.max = String(this.frames.length)
    if (autoplay) {
      this.seek(0)
      this.play()
    } else this.seek(this.frames.length)
  }

  private seek(pos: number) {
    this.pos = Math.max(0, Math.min(this.frames.length, pos))
    const upto = this.pos === 0 ? 0 : this.frames[this.pos - 1]
    const v = computeView(this.sim.steps, upto)
    const animate = this.timer !== null
    this.pipeline.update(v)
    for (const s of ['dns', 'route'] as Stack[]) {
      this.stacks[s].update(v.cards[s], v.current?.stack === s && !v.finished ? v.current.index : undefined)
    }
    if (v.current && !v.finished) this.stacks[v.current.stack].focus(v.current.index, animate)
    renderConn(this.els.conn, this.model, v.conn)
    renderResult(this.els.result, this.model, this.sim.outcome, v.finished)
    renderLog(this.els.log, v.log, this.model, (stack, index) => this.stacks[stack].flash(index))
    this.els.scrub.value = String(this.pos)
    this.els.counter.textContent = `${this.pos} / ${this.frames.length}`
    this.els.play.textContent = this.timer !== null ? '⏸ 暂停' : this.pos >= this.frames.length ? '↺ 重播' : '▶ 播放'
    if (this.timer === null) this.syncHash()
  }

  private play() {
    if (this.pos >= this.frames.length) this.seek(0)
    const tick = () => {
      if (this.pos >= this.frames.length) return this.pause()
      this.seek(this.pos + 1)
      this.timer = window.setTimeout(tick, BASE_INTERVAL / this.speed)
    }
    this.timer = window.setTimeout(tick, 120)
    this.seek(this.pos)
  }

  private pause() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.frames.length) this.seek(this.pos)
  }

  private toggle() {
    if (this.timer !== null) this.pause()
    else this.play()
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) && (e.target as HTMLInputElement).type !== 'range') return
      const act: Record<string, () => void> = {
        ' ': () => this.toggle(),
        ArrowRight: () => (this.pause(), this.seek(this.pos + 1)),
        ArrowLeft: () => (this.pause(), this.seek(this.pos - 1)),
        Home: () => (this.pause(), this.seek(0)),
        End: () => (this.pause(), this.seek(this.frames.length)),
      }
      const fn = act[e.key]
      if (fn && !(tag === 'BUTTON' && e.key === ' ')) {
        e.preventDefault()
        fn()
      }
    })
  }
}
