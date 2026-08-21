// 本机局域网 IP 探测（用于展示给手机用户配置 DNS）
import os from 'node:os';

/** 返回所有局域网 IPv4（排除回环），优先 Wi-Fi 网卡（en0/en1） */
export function getLANIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ address: addr.address, iface: name });
      }
    }
  }
  const wifiLike = /^en\d+$|^wlan\d+$/;
  out.sort((a, b) => {
    const aw = wifiLike.test(a.iface) ? 0 : 1;
    const bw = wifiLike.test(b.iface) ? 0 : 1;
    return aw - bw;
  });
  return out;
}

/** 首选局域网 IP（无则 null） */
export function getPrimaryLANIP() {
  return getLANIPv4s()[0]?.address ?? null;
}
