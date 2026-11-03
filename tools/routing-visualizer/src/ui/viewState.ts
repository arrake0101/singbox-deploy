import type { Meta, Stack, StageKey, StageStatus, Status, Step, Trace } from '../engine/types'

export interface CardView {
  status: Status
  message: string
  trace: Trace
}

export interface StageView {
  status: StageStatus
  value: string
  detail?: string
}

export interface LogItem {
  kind: 'phase' | 'note' | 'rule'
  text: string
  sub?: string
  level?: 'info' | 'warn'
  stack?: Stack
  index?: number
  status?: Status
}

/** 当前被路由对象的元数据，以及同一对象上一次的快照（用于高亮变化）。 */
export interface ConnView {
  subject: string
  meta: Meta
  prev?: Meta
  stack: Stack
  index: number
}

export interface ViewState {
  conn?: ConnView
  cards: Record<Stack, Map<number, CardView>>
  stages: Record<StageKey, StageView>
  log: LogItem[]
  current?: { stack: Stack; index: number }
  finished: boolean
}

export const STAGES: { key: StageKey; title: string }[] = [
  { key: 'entry', title: '入口' },
  { key: 'dns', title: 'DNS 规则栈' },
  { key: 'upstream', title: 'DNS 上游 / 答复' },
  { key: 'route', title: '业务路由栈' },
  { key: 'outbound', title: '出站链路' },
]

const VISIBLE: Step['t'][] = ['rule', 'phase', 'note']

/** 每一「帧」的结束位置（不含）。不可见的 reset / stage 步骤并入下一帧。 */
export function frameEnds(steps: Step[]): number[] {
  const ends: number[] = []
  steps.forEach((s, i) => VISIBLE.includes(s.t) && ends.push(i + 1))
  if (ends.length) ends[ends.length - 1] = steps.length
  else ends.push(steps.length)
  return ends
}

export function computeView(steps: Step[], upto: number): ViewState {
  const v: ViewState = {
    cards: { dns: new Map(), route: new Map() },
    stages: Object.fromEntries(STAGES.map((s) => [s.key, { status: 'idle', value: '—' }])) as ViewState['stages'],
    log: [],
    finished: upto >= steps.length,
  }
  const last = new Map<string, Meta>()
  for (const s of steps.slice(0, upto)) {
    switch (s.t) {
      case 'reset':
        v.cards[s.stack].clear()
        break
      case 'rule':
        v.cards[s.stack].set(s.index, { status: s.status, message: s.message, trace: s.trace })
        v.log.push({ kind: 'rule', text: s.message, stack: s.stack, index: s.index, status: s.status })
        v.current = { stack: s.stack, index: s.index }
        v.conn = { subject: s.subject, meta: s.meta, prev: last.get(s.subject), stack: s.stack, index: s.index }
        last.set(s.subject, s.meta)
        break
      case 'stage':
        v.stages[s.key] = { status: s.status, value: s.value, detail: s.detail }
        break
      case 'phase':
        v.log.push({ kind: 'phase', text: s.text, sub: s.sub })
        break
      case 'note':
        v.log.push({ kind: 'note', text: s.text, level: s.level })
        break
    }
  }
  return v
}
