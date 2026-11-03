export type IpClass = 'cn' | 'foreign' | 'private' | 'telegram'

export interface IpInfo {
  addr: string
  cls: IpClass | 'fake'
  /** 该 IP 命中的 IP 类规则集，例如 geoip-cn。 */
  sets: string[]
  private: boolean
}

/** 规则匹配时可见的元数据。 */
export interface Meta {
  inbound: string
  inboundType: string
  processName: string | null
  processPath: string | null
  clashMode: string
  queryType?: string
  domain: string | null
  domainSets: string[]
  ip: IpInfo | null
  /** DNS evaluate 动作得到的响应，供 match_response 使用。 */
  response?: IpInfo | null
  network?: 'tcp' | 'udp'
  port?: number
  protocol: string | null
}

/** 场景的「真实情况」：只有嗅探 / 真实解析时才会暴露给规则。 */
export interface Truth {
  domain: string | null
  domainSets: string[]
  realIp: IpClass
  sniffProtocol: string | null
}

export type Stack = 'dns' | 'route'
export type Status = 'skip' | 'continue' | 'hit' | 'reject'
export type StageKey = 'entry' | 'dns' | 'upstream' | 'route' | 'outbound'
export type StageStatus = 'idle' | 'active' | 'done' | 'fail' | 'skip'

export interface CondResult {
  ok: boolean
  detail: string
}
export type Trace = Record<string, CondResult>

export type Step =
  | { t: 'reset'; stack: Stack }
  | { t: 'phase'; text: string; sub?: string }
  | { t: 'note'; level: 'info' | 'warn'; text: string }
  | {
      t: 'rule'; stack: Stack; index: number; status: Status; message: string; trace: Trace
      /** 当前被匹配的对象（DNS 查询包 / DNS 查询 / 业务连接 / 内部解析查询）。 */
      subject: string
      /** 该规则执行后的元数据快照。 */
      meta: Meta
    }
  | { t: 'stage'; key: StageKey; status: StageStatus; value: string; detail?: string }

export interface Answer {
  kind: 'empty' | 'fake' | 'real' | 'records' | 'rejected'
  ip?: IpInfo
  text: string
}

export interface DnsResult {
  server: string | null
  answer: Answer
  /** 命中的规则下标；等于 rules.length 表示 final。 */
  index: number
  internal: boolean
}

export interface Hop {
  tag: string
  type: string
  desc: string
}

export interface Chain {
  select: Hop[]
  hops: Hop[]
  resolver?: string
}

export interface Outcome {
  kind: 'outbound' | 'reject' | 'hijack' | 'bypass' | 'dns-only'
  outbound?: string
  chain?: Chain
  dns?: DnsResult
  meta?: Meta
  target: string
  reason?: string
}

export interface SimResult {
  steps: Step[]
  outcome: Outcome
}
