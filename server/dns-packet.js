// DNS 报文解析与构造（零依赖，仅实现本工具所需子集）
// 参考规范: RFC 1035

export const TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
};

export const TYPE_NAME = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  41: 'OPT',
  255: 'ANY',
};

/** 常见污染 IP 池：历史上被广泛记录的 GFW 伪响应地址（用于模拟 DNS 污染） */
export const POLLUTION_IP_POOL = [
  '8.7.198.45', '46.82.174.68', '59.24.3.173', '93.46.8.89',
  '203.98.7.65', '243.185.187.39', '64.33.88.161', '64.66.163.251',
  '65.104.202.252', '65.160.219.113', '66.45.252.237', '72.14.205.99',
  '74.125.127.102', '77.75.76.22', '159.106.121.75', '169.132.13.103',
];

const MAX_NAME_JUMPS = 32; // 防御压缩指针死循环

/**
 * 从 offset 处读取域名（支持压缩指针）
 * 返回 { name, next } — next 为指针未跳转时读取结束后的偏移
 */
export function parseName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('name out of range');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (end === -1) end = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('bad pointer');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (end === -1) end = pos + 2;
      if (++jumps > MAX_NAME_JUMPS) throw new Error('too many pointer jumps');
      pos = ptr;
      continue;
    }
    if (len > 63) throw new Error('bad label length');
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: end };
}

/** 域名转 label 字节序列（不支持压缩，直接展开） */
export function nameToLabels(name) {
  const parts = [];
  for (const label of String(name).split('.')) {
    if (label.length === 0) continue;
    if (label.length > 63) throw new Error('label too long');
    const len = Buffer.alloc(1);
    len[0] = label.length;
    parts.push(len, Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * 解析 DNS 查询报文头部与问题区
 * 返回 { id, flags, questions: [{ name, type, qclass, end }] }
 */
export function parseQuery(buf) {
  if (buf.length < 12) throw new Error('packet too short');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  const questions = [];
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const { name, next } = parseName(buf, offset);
    if (next + 4 > buf.length) throw new Error('bad question');
    const type = buf.readUInt16BE(next);
    const qclass = buf.readUInt16BE(next + 2);
    questions.push({ name, type, qclass, end: next + 4 });
    offset = next + 4;
  }
  return { id, flags, questions };
}

/** 解析应答区记录（用于提取上游应答与 TTL） */
export function parseAnswers(buf, offset, count) {
  const out = [];
  let pos = offset;
  for (let i = 0; i < count; i++) {
    const { name, next } = parseName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) throw new Error('bad answer');
    const type = buf.readUInt16BE(pos); pos += 2;
    const cls = buf.readUInt16BE(pos); pos += 2;
    const ttl = buf.readUInt32BE(pos); pos += 4;
    const rdlength = buf.readUInt16BE(pos); pos += 2;
    if (pos + rdlength > buf.length) throw new Error('bad rdata');
    const data = Buffer.from(buf.slice(pos, pos + rdlength));
    pos += rdlength;
    if (type !== TYPE.OPT) out.push({ name, type, cls, ttl, data });
  }
  return { answers: out, end: pos };
}

/** 跳过问题区，返回应答区起始偏移 */
export function answersOffset(query) {
  return query.questions[query.questions.length - 1].end;
}

/**
 * 基于原始查询构造应答报文（用于劫持/污染/缓存命中/SERVFAIL）
 * answers: [{ name, type, cls, ttl, data }]
 */
export function buildResponse(queryBuf, question, { rcode = 0, answers = [] } = {}) {
  const qd = queryBuf.slice(12, question.end);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(queryBuf.readUInt16BE(0), 0); // ID 与查询一致
  // QR=1 | RD 沿用查询 | RA=1 | RCODE
  const flags = 0x8000 | (queryBuf.readUInt16BE(2) & 0x0100) | 0x0080 | (rcode & 0x0f);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const parts = [header, qd];
  for (const a of answers) {
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(a.type, 0);
    fixed.writeUInt16BE(a.cls ?? 1, 2);
    fixed.writeUInt32BE(Math.max(1, Math.min(a.ttl ?? 60, 86400)), 4);
    fixed.writeUInt16BE(a.data.length, 8);
    parts.push(nameToLabels(a.name), fixed, a.data);
  }
  return Buffer.concat(parts);
}

/** IPv4 → 4 字节 */
export function ipToBuffer(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error('not an IPv4 address');
  const buf = Buffer.alloc(4);
  parts.forEach((p, i) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('bad IPv4 octet');
    buf[i] = n;
  });
  return buf;
}

/** 应答记录数组 → IP 字符串列表（用于日志展示） */
export function answerIPs(answers) {
  const ips = [];
  for (const a of answers) {
    if (a.type === TYPE.A && a.data.length === 4) {
      ips.push([...a.data].join('.'));
    } else if (a.type === TYPE.AAAA && a.data.length === 16) {
      ips.push(formatIPv6(a.data));
    }
  }
  return ips;
}

/** 16 字节 → IPv6 文本（压缩最长零段） */
export function formatIPv6(buf) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((buf[i] << 8) | buf[i + 1]).toString(16));
  // 找最长零段
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  groups.forEach((g, i) => {
    if (g === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  });
  if (bestLen > 1) {
    const head = groups.slice(0, bestStart).join(':');
    const tail = groups.slice(bestStart + bestLen).join(':');
    return `${head}::${tail}`;
  }
  return groups.join(':');
}

/** 从污染池随机取一个 IP */
export function randomPollutionIP() {
  return POLLUTION_IP_POOL[Math.floor(Math.random() * POLLUTION_IP_POOL.length)];
}
