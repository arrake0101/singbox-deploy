/** 规则前方的注释块：普通说明文字，或被注释掉的规则。 */
export interface Section {
  kind: 'text' | 'disabled-rule'
  text: string
}

export interface RuleEntry {
  index: number
  raw: Record<string, any>
  /** 从注释中提取的编号，如 D1 / B3。 */
  tag?: string
  /** 紧贴规则的注释（已去掉编号前缀）。 */
  note?: string
  /** 规则上方、与说明之间以空行分隔的其他注释块。 */
  sections: Section[]
}

export interface FinalEntry {
  target: string
  tag?: string
  note?: string
}

export type RuleSetKind = 'domain' | 'ip'

export interface RuleSetInfo {
  tag: string
  kind: RuleSetKind
  url?: string
}

export interface InboundInfo {
  tag: string
  type: string
  listen?: string
  port?: number
  note?: string
}

export interface ConfigModel {
  name: string
  header?: string
  raw: any
  dnsRules: RuleEntry[]
  dnsFinal: FinalEntry
  dnsStrategy?: string
  routeRules: RuleEntry[]
  routeFinal: FinalEntry
  dnsServers: Record<string, any>
  outbounds: Record<string, any>
  inbounds: InboundInfo[]
  ruleSets: RuleSetInfo[]
  ruleSetKinds: Record<string, RuleSetKind>
  defaultMode: string
  defaultDomainResolver?: string
}
