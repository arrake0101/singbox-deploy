import { findNodeAtLocation, getNodeValue, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser'
import type { ConfigModel, FinalEntry, RuleEntry, RuleSetKind, Section } from './types'

const TAG_RE = /^([A-Z]\d+[a-z]?(?:\s*\/\s*[A-Z]\d+[a-z]?)*)\s*[：:]\s*/

/** 把一段 JSON 值之间的文本切分为注释块（以空行分隔）。 */
export function commentBlocks(slice: string): string[] {
  const blocks: string[] = []
  let cur: string[] = []
  let inBlock = false
  const flush = () => {
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
  }
  for (const line of slice.split(/\r?\n/)) {
    const t = line.trim()
    if (inBlock) {
      const end = t.indexOf('*/')
      const body = (end >= 0 ? t.slice(0, end) : t).replace(/^\*\s?/, '').trim()
      if (body) cur.push(body)
      if (end >= 0) inBlock = false
      continue
    }
    const s = t.replace(/^,\s*/, '')
    if (!s) {
      flush()
      continue
    }
    if (s.startsWith('//')) {
      cur.push(s.replace(/^\/\/\s?/, ''))
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/')
      const body = s.slice(2, end >= 0 ? end : undefined).trim()
      if (body) cur.push(body)
      if (end < 0) inBlock = true
    }
  }
  flush()
  return blocks
}

const looksLikeRule = (text: string) => /^\s*\{/.test(text)

/** 取得节点之前、上一个兄弟节点之后的注释块。 */
function commentsBefore(text: string, siblings: Node[], i: number, containerStart: number): string[] {
  const node = siblings[i]
  const start = i === 0 ? containerStart + 1 : siblings[i - 1].offset + siblings[i - 1].length
  let slice = text.slice(start, node.offset)
  // 上一个节点同一行的尾随注释属于上一个节点。
  if (i > 0) slice = slice.includes('\n') ? slice.slice(slice.indexOf('\n') + 1) : ''
  return commentBlocks(slice)
}

function splitTag(note: string | undefined): { tags: string[]; note?: string } {
  if (!note) return { tags: [] }
  const m = note.match(TAG_RE)
  if (!m) return { tags: [], note }
  return { tags: m[1].split('/').map((s) => s.trim()), note: note.slice(m[0].length).trim() || undefined }
}

function annotateArray(text: string, arr: Node | undefined): RuleEntry[] {
  const kids = arr?.children ?? []
  let pending: string[] = []
  return kids.map((n, i) => {
    const blocks = commentsBefore(text, kids, i, arr!.offset)
    const sections: Section[] = []
    let note: string | undefined
    blocks.forEach((b, bi) => {
      if (looksLikeRule(b)) sections.push({ kind: 'disabled-rule', text: b })
      else if (bi < blocks.length - 1) sections.push({ kind: 'text', text: b })
      else note = b
    })
    const split = splitTag(note)
    let tag: string | undefined
    if (split.tags.length) {
      tag = split.tags[0]
      pending = split.tags.slice(1)
    } else if (!note && pending.length) {
      tag = pending.shift()
    } else {
      pending = []
    }
    return { index: i, raw: getNodeValue(n), tag, note: split.note, sections }
  })
}

function annotateProperty(text: string, root: Node, path: string[]): { tag?: string; note?: string } {
  const valueNode = findNodeAtLocation(root, path)
  const prop = valueNode?.parent
  const obj = prop?.parent
  if (!prop || !obj?.children) return {}
  const idx = obj.children.indexOf(prop)
  const blocks = commentsBefore(text, obj.children, idx, obj.offset)
  const last = blocks.filter((b) => !looksLikeRule(b)).at(-1)
  const { tags, note } = splitTag(last)
  return { tag: tags[0], note }
}

export class ConfigError extends Error {}

export function parseConfig(text: string, name = 'config.jsonc'): ConfigModel {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (!root) throw new ConfigError('无法解析配置文件')
  if (errors.length) {
    const e = errors[0]
    const line = text.slice(0, e.offset).split('\n').length
    throw new ConfigError(`JSONC 语法错误：${printParseErrorCode(e.error)}（第 ${line} 行）`)
  }
  const raw = getNodeValue(root)
  if (!Array.isArray(raw?.dns?.rules) || !Array.isArray(raw?.route?.rules)) {
    throw new ConfigError('配置缺少 dns.rules 或 route.rules')
  }

  const byTag = (list: any[] | undefined) => Object.fromEntries((list ?? []).filter((x) => x?.tag).map((x) => [x.tag, x]))
  const ruleSets = (raw.route.rule_set ?? []).map((rs: any) => ({
    tag: rs.tag as string,
    kind: (/^geoip/i.test(rs.tag) ? 'ip' : 'domain') as RuleSetKind,
    url: rs.url as string | undefined,
  }))
  const inboundNotes = annotateArray(text, findNodeAtLocation(root, ['inbounds']))
  const header = root.children?.length ? commentBlocks(text.slice(root.offset + 1, root.children[0].offset)).join('\n') : undefined

  const dnsFinal: FinalEntry = { target: raw.dns.final ?? Object.keys(byTag(raw.dns.servers))[0], ...annotateProperty(text, root, ['dns', 'final']) }
  const routeFinal: FinalEntry = { target: raw.route.final ?? raw.outbounds?.[0]?.tag, ...annotateProperty(text, root, ['route', 'final']) }

  return {
    name,
    header: header || undefined,
    raw,
    dnsRules: annotateArray(text, findNodeAtLocation(root, ['dns', 'rules'])),
    dnsFinal,
    dnsStrategy: raw.dns.strategy,
    routeRules: annotateArray(text, findNodeAtLocation(root, ['route', 'rules'])),
    routeFinal,
    dnsServers: byTag(raw.dns.servers),
    outbounds: byTag(raw.outbounds),
    inbounds: (raw.inbounds ?? []).map((ib: any, i: number) => ({
      tag: ib.tag,
      type: ib.type,
      listen: ib.listen,
      port: ib.listen_port,
      note: inboundNotes[i]?.note,
    })),
    ruleSets,
    ruleSetKinds: Object.fromEntries(ruleSets.map((r: { tag: string; kind: RuleSetKind }) => [r.tag, r.kind])),
    defaultMode: raw.experimental?.clash_api?.default_mode ?? 'Rule',
    defaultDomainResolver: typeof raw.route.default_domain_resolver === 'string' ? raw.route.default_domain_resolver : raw.route.default_domain_resolver?.server,
  }
}
