import type { ConfigModel } from '../config/types'
import type { Chain, Hop } from './types'

function hopOf(tag: string, o: any): Hop {
  if (!o) return { tag, type: '?', desc: '配置中不存在该出站' }
  if (o.type === 'direct') return { tag, type: 'direct', desc: '本机网卡直连' }
  if (o.type === 'block') return { tag, type: 'block', desc: '丢弃' }
  const addr = o.server ? `${o.server}:${o.server_port ?? ''}` : ''
  return { tag, type: o.type, desc: [o.type, addr].filter(Boolean).join(' · ') }
}

/** 解析出站：选择器 → 选中节点 → detour 前置链。hops 按数据实际经过的顺序排列。 */
export function outboundChain(model: ConfigModel, tag: string): Chain {
  const select: Hop[] = []
  const seen = new Set<string>()
  let cur = tag
  for (;;) {
    const o = model.outbounds[cur]
    if (!o || !['selector', 'urltest'].includes(o.type) || seen.has(cur)) break
    seen.add(cur)
    const next = o.default ?? o.outbounds?.[0]
    select.push({ tag: cur, type: o.type, desc: `${o.type === 'selector' ? '选择器' : '测速组'} · ${o.outbounds?.length ?? 0} 个候选 · 当前 ${next}` })
    if (!next) break
    cur = next
  }
  const hops: Hop[] = []
  const seenHop = new Set<string>()
  let h: string | undefined = cur
  while (h && !seenHop.has(h)) {
    seenHop.add(h)
    const o: any = model.outbounds[h]
    hops.unshift(hopOf(h, o))
    h = o?.detour
  }
  return { select, hops, resolver: model.outbounds[cur]?.domain_resolver }
}

export function dnsServerDesc(model: ConfigModel, tag: string | null): string {
  if (!tag) return '—'
  const s = model.dnsServers[tag]
  if (!s) return `${tag}（未定义）`
  let base: string
  switch (s.type) {
    case 'fakeip':
      base = `FakeIP ${[s.inet4_range, s.inet6_range].filter(Boolean).join(' · ')}`
      break
    case 'local':
      base = '系统 DNS'
      break
    case 'https':
      base = `DoH ${s.server}${s.path ?? '/dns-query'}`
      break
    case 'tls':
      base = `DoT ${s.server}`
      break
    case 'quic':
      base = `DoQ ${s.server}`
      break
    default:
      base = `${s.type} ${s.server ?? ''}`.trim()
  }
  return s.detour ? `${base} · 经 ${s.detour}` : base
}
