// 可疑应答 IP 检测：上游返回保留/私有地址段通常意味着
// 本机代理（Clash TUN fake-ip、VPN 等）劫持了 DNS Lab 的上游查询
const PRIVATE_RANGES = [
  // [起始 IP 的 32 位整数, 掩码位数, 说明]
  [ip2int('198.18.0.0'), 15, 'fake-ip 常用池 (RFC 2544 基准测试段)'],
  [ip2int('192.0.2.0'), 24, 'TEST-NET-1 测试保留段'],
  [ip2int('192.168.0.0'), 16, '内网私有段'],
  [ip2int('10.0.0.0'), 8, '内网私有段'],
  [ip2int('172.16.0.0'), 12, '内网私有段'],
  [ip2int('127.0.0.0'), 8, '回环地址'],
  [ip2int('0.0.0.0'), 8, '无效地址'],
];

function ip2int(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

/**
 * 判断一个 IPv4 应答是否为可疑的保留/私有地址
 * @returns {string|null} 命中则返回原因说明，否则 null
 */
export function suspiciousIPReason(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
  const n = ip2int(ip);
  for (const [base, bits, label] of PRIVATE_RANGES) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return label;
  }
  return null;
}

/** 从应答 IP 列表中找出第一个可疑 IP 及原因；无可疑则 null */
export function findSuspicious(ips) {
  for (const ip of ips || []) {
    const reason = suspiciousIPReason(ip);
    if (reason) return { ip, reason };
  }
  return null;
}
