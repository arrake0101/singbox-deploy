import type { IpClass, IpInfo } from './types'

export const IP_CLASSES: Record<IpClass, { label: string; v4: string; v6: string; sets: string[]; private: boolean }> = {
  cn: { label: '国内 IP', v4: '110.242.68.66', v6: '240e:e9:6002::ff', sets: ['geoip-cn'], private: false },
  foreign: { label: '国外 IP', v4: '142.250.66.68', v6: '2404:6800:4005:81d::2004', sets: [], private: false },
  private: { label: '私网 IP', v4: '192.168.1.10', v6: 'fd00::10', sets: [], private: true },
  telegram: { label: 'Telegram IP', v4: '91.108.56.130', v6: '2001:67c:4e8::a', sets: ['geoip-telegram'], private: false },
}

export const ipClassLabel = (cls: IpInfo['cls']) => (cls === 'fake' ? 'FakeIP' : IP_CLASSES[cls].label)

export function makeIp(cls: IpClass, v6 = false): IpInfo {
  const c = IP_CLASSES[cls]
  return { addr: v6 ? c.v6 : c.v4, cls, sets: [...c.sets], private: c.private }
}

/** 从 fakeip 服务器的地址段里取一个示例地址。 */
export function fakeIp(server: any, v6 = false): IpInfo {
  let addr: string
  if (v6) {
    const base = String(server?.inet6_range ?? 'fc00::/18').split('/')[0]
    addr = base.replace(/::$/, '') + '::1b'
  } else {
    const parts = String(server?.inet4_range ?? '198.18.0.0/15').split('/')[0].split('.').map(Number)
    parts[3] = (parts[3] ?? 0) + 27
    addr = parts.join('.')
  }
  return { addr, cls: 'fake', sets: [], private: false }
}

function v4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

/** 仅支持 IPv4 CIDR，足够用于可视化。 */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/')
  const a = v4ToInt(ip)
  const b = v4ToInt(net)
  if (a == null || b == null) return false
  const bits = bitsStr == null ? 32 : Number(bitsStr)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}
