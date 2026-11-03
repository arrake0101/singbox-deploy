import { describe, expect, it } from 'vitest'
import templateText from '../../../config/client-routing.template.jsonc?raw'
import { commentBlocks, parseConfig } from '../src/config/parse'
import { buildCond, evalCond } from '../src/engine/conditions'
import { simulate } from '../src/engine/simulate'
import type { Meta } from '../src/engine/types'
import { PRESETS, presetInput, toScenario } from '../src/scenario/catalog'

const model = parseConfig(templateText, 'client-routing.template.jsonc')

describe('parseConfig', () => {
  it('读取 DNS 与业务规则', () => {
    expect(model.dnsRules.length).toBeGreaterThan(5)
    expect(model.routeRules.length).toBeGreaterThan(5)
    expect(model.dnsFinal.target).toBe('dns_proxy')
    expect(model.routeFinal.target).toBe('Proxy')
    expect(model.inbounds.map((i) => i.tag)).toEqual(['tun-in', 'mixed-in', 'claude-in'])
  })

  it('从注释中提取编号与说明', () => {
    const tags = model.dnsRules.map((r) => r.tag)
    expect(tags).toContain('D0')
    expect(tags).toContain('D5')
    const routeTags = model.routeRules.map((r) => r.tag)
    expect(routeTags).toContain('B1')
    // "B3 / B4：" 依次分配给相邻两条规则
    const b3 = routeTags.indexOf('B3')
    expect(routeTags[b3 + 1]).toBe('B4')
    expect(model.routeFinal.tag).toBe('B8')
  })

  it('识别被注释掉的规则与分节注释', () => {
    expect(model.routeRules[0].sections.some((s) => s.kind === 'disabled-rule')).toBe(true)
    const d5 = model.dnsRules.find((r) => r.tag === 'D5')!
    expect(d5.sections.some((s) => s.text.startsWith('D4'))).toBe(true)
  })

  it('commentBlocks 以空行切分', () => {
    expect(commentBlocks('\n // a\n // b\n\n /* c */\n')).toEqual(['a\nb', 'c'])
  })

  it('非法 JSONC 报错', () => {
    expect(() => parseConfig('{ "dns": ')).toThrow()
    expect(() => parseConfig('{}')).toThrow(/dns.rules/)
  })
})

describe('conditions', () => {
  const meta: Meta = {
    inbound: 'tun-in', inboundType: 'tun', processName: null, processPath: null, clashMode: 'Rule',
    queryType: 'A', domain: 'x.com', domainSets: ['geosite-cn'], ip: null, protocol: null,
  }
  const ctx = { phase: 'dns' as const, ruleSetKinds: model.ruleSetKinds }

  it('logical + invert', () => {
    const c = buildCond({ type: 'logical', mode: 'and', rules: [{ query_type: ['A'] }, { rule_set: 'geosite-geolocation-!cn', invert: true }] })
    expect(evalCond(c, meta, ctx, {}).ok).toBe(true)
    expect(evalCond(c, { ...meta, domainSets: ['geosite-geolocation-!cn'] }, ctx, {}).ok).toBe(false)
  })

  it('默认规则字段之间为 AND', () => {
    const c = buildCond({ clash_mode: 'Global', query_type: ['A', 'AAAA'] })
    expect(evalCond(c, meta, ctx, {}).ok).toBe(false)
    expect(evalCond(c, { ...meta, clashMode: 'global' }, ctx, {}).ok).toBe(true)
  })

  it('DNS 阶段 geoip 集合只匹配 match_response', () => {
    const resp = { addr: '1.1.1.1', cls: 'cn' as const, sets: ['geoip-cn'], private: false }
    const plain = buildCond({ rule_set: 'geoip-cn' })
    const withResp = buildCond({ match_response: true, rule_set: 'geoip-cn' })
    expect(evalCond(plain, { ...meta, response: resp }, ctx, {}).ok).toBe(false)
    expect(evalCond(withResp, { ...meta, response: resp }, ctx, {}).ok).toBe(true)
    expect(evalCond(withResp, meta, ctx, {}).ok).toBe(false)
  })
})

describe('场景预设（针对仓库模板）', () => {
  for (const p of PRESETS) {
    it(`${p.group} · ${p.title}`, () => {
      const { outcome, steps } = simulate(model, toScenario(presetInput(p), model))
      expect(outcome.kind).toBe(p.expect.kind)
      if (p.expect.outbound) expect(outcome.outbound).toBe(p.expect.outbound)
      if (p.expect.dnsServer !== undefined) expect(outcome.dns?.server ?? null).toBe(p.expect.dnsServer)
      expect(steps.some((s) => s.t === 'rule')).toBe(true)
    })
  }

  it('Claude 出站链路：前置节点在固定出口之前', () => {
    const p = PRESETS.find((x) => x.id === 'claude-browser')!
    const { outcome } = simulate(model, toScenario(presetInput(p), model))
    expect(outcome.chain?.select.map((h) => h.tag)).toEqual(['Claude'])
    expect(outcome.chain?.hops.map((h) => h.tag)).toEqual(['CLAUDE_FRONT', 'CLAUDE_FIXED'])
  })

  it('连接元数据随规则变化：嗅探补协议/域名，resolve 补 IP', () => {
    // TUN + 国外未知域名 → 真实 IP 情况下嗅探从 SNI 拿回域名
    const sniffCase = simulate(model, toScenario({ ...presetInput(PRESETS.find((x) => x.id === 'fakeip-filter')!) }, model))
    const conn = sniffCase.steps.filter((s) => s.t === 'rule' && s.subject === '业务连接')
    const first = conn[0]
    expect(first.t === 'rule' && first.meta.protocol).toBe('tls')
    expect(first.t === 'rule' && first.meta.domain).toBe('stun.l.google.com')

    const resolveCase = simulate(model, toScenario(presetInput(PRESETS.find((x) => x.id === 'mixed-cn')!), model))
    const rs = resolveCase.steps.filter((s) => s.t === 'rule' && s.subject === '业务连接')
    const before = rs.find((s) => s.t === 'rule' && s.message.startsWith('resolve：'))
    const after = rs.find((s) => s.t === 'rule' && s.message.startsWith('resolve 完成'))
    expect(before?.t === 'rule' && before.meta.ip).toBeNull()
    expect(after?.t === 'rule' && after.meta.ip?.sets).toEqual(['geoip-cn'])
  })

  it('内部解析跳过 FakeIP 规则', () => {
    const p = PRESETS.find((x) => x.id === 'mixed-intl')!
    const { steps } = simulate(model, toScenario(presetInput(p), model))
    expect(steps.some((s) => s.t === 'rule' && s.stack === 'dns' && s.status === 'skip' && s.message.includes('FakeIP'))).toBe(true)
  })
})
