// UDP DNS 服务器：规则裁决 → 劫持/污染应答 或 上游转发(带缓存)
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  parseQuery, parseAnswers, buildResponse,
  ipToBuffer, answerIPs, randomPollutionIP, TYPE,
} from './dns-packet.js';
import { findSuspicious } from './ip-sentinel.js';

const HIJACK_TTL = 30; // 劫持应答 TTL，短一点方便演示中快速恢复
const UPSTREAM_TIMEOUT = 3500;
const MAX_INFLIGHT = 256;
const LOG_CAPACITY = 500;
const CACHE_CAPACITY = 500;

export class DnsServer extends EventEmitter {
  constructor({ rules, upstream, wantedPort = 53, fallbackPorts = [5353] }) {
    super();
    this.rules = rules;
    this.upstream = upstream;
    this.wantedPort = wantedPort;
    this.fallbackPorts = [...fallbackPorts];
    this.socket = null;
    this.port = null;
    this.privilegedWarning = false; // true = 因权限不足回退到了非特权端口
    this.startedAt = null;
    this.cache = new Map(); // `${domain}|${type}` → { answers, ips, expiresAt }
    this.logs = []; // 环形日志（最新在前）
    this.stats = this.#freshStats();
    this.clients = new Map(); // ip → { firstSeen, lastSeen, count }
    this.domains = new Set();
    this.seq = 0;
    this.inflight = 0;
  }

  #freshStats() {
    return {
      total: 0, forward: 0, cache: 0, hijack: 0,
      pollute: 0, nxdomain: 0, drop: 0, error: 0,
      suspicious: 0, // 上游应答含保留/私有地址（疑似被本机代理劫持）
    };
  }

  resetStats() {
    this.stats = this.#freshStats();
    this.clients.clear();
    this.domains.clear();
    this.logs = [];
    this.emit('stats', this.getStats());
  }

  getStats() {
    return {
      ...this.stats,
      clients: this.clients.size,
      uniqueDomains: this.domains.size,
      cacheEntries: this.cache.size,
      startedAt: this.startedAt,
      lastSuspicious: this.lastSuspicious ?? null,
    };
  }

  getRecentQueries(limit = 200) {
    return this.logs.slice(0, limit);
  }

  /** 外部客户端（手机等）：排除回环与本机 IP；120 秒内有查询视为在线 */
  getPhoneClients(excludeIPs = []) {
    const now = Date.now();
    const out = [];
    for (const [ip, c] of this.clients) {
      if (ip.startsWith('127.') || ip === '::1' || excludeIPs.includes(ip)) continue;
      out.push({
        ip,
        name: null, // 由 WebServer 合并 DeviceStore 中的备注名
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        queries: c.count,
        firstDomain: c.firstDomain || null,
        online: now - c.lastSeen < 120_000,
      });
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  getCacheEntries() {
    return [...this.cache.entries()].map(([key, v]) => ({
      key, ips: v.ips, expiresAt: v.expiresAt,
    }));
  }

  clearCache() {
    this.cache.clear();
  }

  setUpstream(ip) {
    this.upstream = ip;
    this.cache.clear(); // 切换上游后旧缓存失效
    this.emit('config');
  }

  /** 依次尝试端口绑定：无权限/占用时自动回退 */
  async start() {
    const ports = [this.wantedPort, ...this.fallbackPorts];
    let lastErr = null;
    for (const port of ports) {
      try {
        await this.#bind(port);
        this.port = port;
        this.startedAt = Date.now();
        this.privilegedWarning =
          port !== this.wantedPort && this.wantedPort < 1024;
        this.emit('started', { port, wanted: this.wantedPort, privilegedWarning: this.privilegedWarning });
        return { port, wanted: this.wantedPort, privilegedWarning: this.privilegedWarning };
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EACCES' && err.code !== 'EADDRINUSE') throw err;
      }
    }
    throw lastErr ?? new Error('端口绑定失败');
  }

  #bind(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const onError = (err) => { try { sock.close(); } catch {} reject(err); };
      sock.once('error', onError);
      sock.bind(port, '0.0.0.0', () => {
        sock.removeListener('error', onError);
        sock.on('error', (err) => console.error(`[dns] socket error: ${err.message}`));
        sock.on('message', (msg, rinfo) => {
          try { this.#onMessage(msg, rinfo); }
          catch (err) { console.error(`[dns] 处理报文失败: ${err.message}`); }
        });
        this.socket = sock;
        resolve();
      });
    });
  }

  stop() {
    if (this.socket) { try { this.socket.close(); } catch {} this.socket = null; }
  }

  async #onMessage(msg, rinfo) {
    let query;
    try {
      query = parseQuery(msg);
    } catch {
      this.stats.error += 1; // 无法解析的报文，直接丢弃
      return;
    }
    if (query.questions.length === 0) return;
    const q = query.questions[0];
    const domain = q.name.toLowerCase().replace(/\.$/, '');
    const client = rinfo.address;

    // 记录客户端与唯一域名（firstDomain 用于在多设备场景下辅助识别设备）
    const known = this.clients.has(client);
    if (!known) this.clients.set(client, { firstSeen: Date.now(), lastSeen: Date.now(), count: 0, firstDomain: domain });
    const c = this.clients.get(client);
    c.lastSeen = Date.now(); c.count += 1;
    this.domains.add(domain);

    const rule = this.rules.match(domain);
    const typeLabel = q.type === TYPE.A ? 'A' : q.type === TYPE.AAAA ? 'AAAA' : (q.typeName || `TYPE${q.type}`);

    // ── 规则裁决（drop 之外的动作立即构造应答） ──
    if (rule && rule.action !== 'forward') {
      const entry = this.#log({
        client, domain, type: typeLabel, ruleDomain: rule.domain, action: rule.action,
        ips: [], latency: 0, firstVisit: !known,
      });
      if (rule.action === 'drop') {
        this.stats.drop += 1; this.stats.total += 1;
        this.#broadcast(entry);
        return;
      }
      let response = null;
      try {
        if (rule.action === 'nxdomain') {
          response = buildResponse(msg, q, { rcode: 3, answers: [] });
        } else if (rule.action === 'hijack' || rule.action === 'pollute') {
          const ip = rule.action === 'hijack' ? rule.ip : randomPollutionIP();
          // 仅 A 查询返回地址记录；AAAA/其他类型返回空 NOERROR，引导客户端回落到 A 查询
          const answers = q.type === TYPE.A
            ? [{ name: domain, type: TYPE.A, ttl: HIJACK_TTL, data: ipToBuffer(ip) }]
            : [];
          response = buildResponse(msg, q, { rcode: 0, answers });
          entry.ips = q.type === TYPE.A ? [ip] : [];
        }
      } catch (err) {
        console.error(`[dns] 构造应答失败: ${err.message}`);
        response = buildResponse(msg, q, { rcode: 2, answers: [] });
        entry.action = 'error';
      }
      if (response) this.socket.send(response, rinfo.port, client);
      this.stats[entry.action] += 1; this.stats.total += 1;
      this.#broadcast(entry);
      return;
    }

    // ── 正常转发路径（含缓存） ──
    const cacheKey = `${domain}|${q.type}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      const response = buildResponse(msg, q, { rcode: 0, answers: hit.answers });
      this.socket.send(response, rinfo.port, client);
      const entry = this.#log({
        client, domain, type: typeLabel, action: 'cache',
        ips: hit.ips, latency: 0, firstVisit: !known,
      });
      this.#markSuspicious(entry);
      this.stats.cache += 1; this.stats.total += 1;
      this.#broadcast(entry);
      return;
    }
    this.cache.delete(cacheKey);

    if (this.inflight >= MAX_INFLIGHT) {
      this.socket.send(buildResponse(msg, q, { rcode: 2, answers: [] }), rinfo.port, client);
      const entry = this.#log({
        client, domain, type: typeLabel, action: 'error',
        ips: ['并发过高，返回 SERVFAIL'], latency: 0, firstVisit: !known,
      });
      this.stats.error += 1; this.stats.total += 1;
      this.#broadcast(entry);
      return;
    }

    const started = Date.now();
    this.inflight += 1;
    try {
      const raw = await this.#resolveUpstream(msg);
      this.socket.send(raw, rinfo.port, client);
      const latency = Date.now() - started;
      // 解析应答用于日志展示与缓存（仅处理单问题的常规报文）
      const rcode = raw.readUInt16BE(2) & 0x0f;
      const ancount = raw.readUInt16BE(6);
      let ips = [];
      let answers = null;
      if (rcode === 0 && ancount > 0 && query.questions.length === 1) {
        try {
          const parsed = parseAnswers(raw, q.end, ancount);
          ips = answerIPs(parsed.answers);
          answers = parsed.answers;
        } catch { /* 解析失败不影响转发 */ }
      }

      const entry = this.#log({
        client, domain, type: typeLabel, action: 'forward',
        ips, latency, firstVisit: !known,
      });
      this.#markSuspicious(entry);
      // 写入缓存（仅 RCODE=0 且含应答记录）
      if (rcode === 0 && answers && answers.length) {
        const minTtl = Math.min(...answers.map(a => a.ttl || 0), 300);
        if (minTtl > 0) {
          this.cache.set(cacheKey, {
            answers, ips,
            expiresAt: Date.now() + Math.max(5, minTtl) * 1000,
          });
          if (this.cache.size > CACHE_CAPACITY) {
            this.cache.delete(this.cache.keys().next().value);
          }
        }
      }
      this.stats.forward += 1; this.stats.total += 1;
      this.#broadcast(entry);
    } catch (err) {
      // 上游超时/失败 → SERVFAIL，让客户端尽快放弃
      this.socket.send(buildResponse(msg, q, { rcode: 2, answers: [] }), rinfo.port, client);
      const entry = this.#log({
        client, domain, type: typeLabel, action: 'error',
        ips: [`上游无响应 (${err.message})`], latency: Date.now() - started, firstVisit: !known,
      });
      this.stats.error += 1; this.stats.total += 1;
      this.#broadcast(entry);
    } finally {
      this.inflight -= 1;
    }
  }

  /** 将原始查询转发到上游，回传原始应答（保真转发） */
  #resolveUpstream(msg) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const id = msg.readUInt16BE(0);
      const timer = setTimeout(() => {
        cleanup();
        try { sock.close(); } catch {}
        reject(new Error('timeout'));
      }, UPSTREAM_TIMEOUT);
      const onMessage = (resp) => {
        if (resp.length < 12 || resp.readUInt16BE(0) !== id) return; // ID 不匹配，忽略
        clearTimeout(timer);
        try { sock.close(); } catch {}
        resolve(resp);
      };
      const onError = (err) => {
        clearTimeout(timer);
        try { sock.close(); } catch {}
        reject(err);
      };
      const cleanup = () => { sock.removeListener('message', onMessage); sock.removeListener('error', onError); };
      sock.on('message', onMessage);
      sock.once('error', onError);
      sock.send(msg, 53, this.upstream, (err) => {
        if (err) { clearTimeout(timer); try { sock.close(); } catch {} reject(err); }
      });
    });
  }

  /** 检测转发应答中的保留/私有 IP（疑似本机代理 fake-ip 劫持）；仅 forward/cache 路径使用 */
  #markSuspicious(entry) {
    const hit = findSuspicious(entry.ips);
    if (!hit) return;
    entry.suspicious = hit;
    this.stats.suspicious += 1;
    this.lastSuspicious = { ts: entry.ts, ip: hit.ip, reason: hit.reason, domain: entry.domain };
  }

  #log(fields) {
    const entry = { seq: ++this.seq, ts: Date.now(), ...fields };
    this.logs.unshift(entry);
    if (this.logs.length > LOG_CAPACITY) this.logs.pop();
    return entry;
  }

  #broadcast(entry) {
    this.emit('query', entry);
    this.emit('stats', this.getStats());
  }
}
