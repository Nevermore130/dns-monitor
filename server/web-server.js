// HTTP 服务：REST API + SSE 实时推送 + 控制台静态资源 + 80 端口劫持演示页
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLANIPv4s, getPrimaryLANIP } from './netinfo.js';
import { PRESETS } from './rule-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** 语言探测：?lang= 覆盖 > Accept-Language > 默认英文 */
function detectLang(req, url) {
  const q = url?.searchParams?.get('lang');
  if (q === 'zh' || q === 'en') return q;
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  return al.startsWith('zh') ? 'zh' : 'en';
}

export class WebServer {
  constructor({ dnsServer, rules, devices, wantedPort = 3000, wantedDemoPort = 80 }) {
    this.dns = dnsServer;
    this.rules = rules;
    this.devices = devices;
    this.wantedPort = wantedPort;
    this.wantedDemoPort = wantedDemoPort;
    this.port = null;
    this.demoPort = null; // 80 端口劫持演示页（非 root 通常拿不到）
    this.sseClients = new Set();
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
  }

  async start() {
    // 控制台端口：占用时依次 +1
    for (let port = this.wantedPort; port < this.wantedPort + 20; port++) {
      try {
        await this.#listen(this.server, port);
        this.port = port;
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      }
    }
    if (this.port === null) throw new Error(`控制台端口 ${this.wantedPort}+ 无法绑定`);

    // 80 端口演示页（尽力而为，无权限则跳过）
    this.demoServer = http.createServer((req, res) => this.#serveHijackPage(req, res));
    try {
      await this.#listen(this.demoServer, this.wantedDemoPort);
      this.demoPort = this.wantedDemoPort;
    } catch {
      this.demoPort = null; // 无 root 权限时属预期情况
    }

    // SSE 事件接线
    this.dns.on('query', (entry) => this.#broadcast({ type: 'query', data: entry }));
    this.dns.on('stats', (stats) => this.#broadcast({ type: 'stats', data: stats }));
    this.dns.on('config', () => this.#broadcast({ type: 'status-changed' }));
    this.rules.on('change', (rules) => this.#broadcast({ type: 'rules', data: rules }));

    // SSE 心跳，防止连接被中间层断开
    this.heartbeat = setInterval(() => {
      for (const res of this.sseClients) res.write(': ping\n\n');
    }, 20000);
    this.heartbeat.unref();

    return { port: this.port, demoPort: this.demoPort };
  }

  #listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.removeListener('listening', onOk); reject(err); };
      const onOk = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(port, '0.0.0.0');
    });
  }

  stop() {
    clearInterval(this.heartbeat);
    for (const res of this.sseClients) try { res.end(); } catch {}
    this.server.close();
    if (this.demoServer) this.demoServer.close();
  }

  // ── 路由 ─────────────────────────────────────────────
  async #onRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;

      if (path === '/api/events') return this.#handleSSE(req, res);
      if (path.startsWith('/api/')) return this.#handleApi(req, res, url);
      return this.#serveStatic(path, res);
    } catch (err) {
      this.#json(res, 500, { error: err.message });
    }
  }

  #json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async #readBody(req, lang = 'en', limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error(lang === 'zh' ? '请求体过大' : 'Request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error(lang === 'zh' ? '请求体不是合法 JSON' : 'Request body is not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  async #handleApi(req, res, url) {
    const { method } = req;
    const path = url.pathname;
    const lanIP = getPrimaryLANIP();
    const lang = detectLang(req, url);

    // 规则 CRUD
    if (path === '/api/rules' && method === 'GET') {
      return this.#json(res, 200, { rules: this.rules.list() });
    }
    if (path === '/api/rules' && method === 'POST') {
      const body = await this.#readBody(req, lang);
      const result = this.rules.add({ ...body, lang });
      return result.error
        ? this.#json(res, 400, result)
        : this.#json(res, 200, result);
    }
    if (path === '/api/rules/clear' && method === 'POST') {
      const body = await this.#readBody(req, lang);
      return this.#json(res, 200, this.rules.clear(body.note));
    }
    const ruleMatch = path.match(/^\/api\/rules\/([a-f0-9]+)$/);
    if (ruleMatch) {
      const id = ruleMatch[1];
      if (method === 'PATCH') {
        const body = await this.#readBody(req, lang);
        const result = this.rules.update(id, body, lang);
        return result.error ? this.#json(res, 400, result) : this.#json(res, 200, result);
      }
      if (method === 'DELETE') {
        const result = this.rules.remove(id, lang);
        return result.error ? this.#json(res, 404, result) : this.#json(res, 200, result);
      }
    }

    // 预设
    if (path === '/api/presets' && method === 'GET') {
      return this.#json(res, 200, {
        presets: Object.values(PRESETS),
        lanIP,
        demoPort: this.demoPort,
      });
    }
    const presetMatch = path.match(/^\/api\/presets\/([\w-]+)\/apply$/);
    if (presetMatch && method === 'POST') {
      const result = this.rules.applyPreset(presetMatch[1], { lanIP, lang });
      return result.error ? this.#json(res, 400, result) : this.#json(res, 200, result);
    }

    // 设备备注名（多设备区分）
    const deviceMatch = path.match(/^\/api\/devices\/((\d{1,3}\.){3}\d{1,3})$/);
    if (deviceMatch && method === 'PATCH') {
      const body = await this.#readBody(req, lang);
      const result = this.devices.set(deviceMatch[1], body.name, lang);
      if (result.error) return this.#json(res, 400, result);
      this.#broadcast({ type: 'status-changed' }); // 各标签页同步新名字
      return this.#json(res, 200, { phones: this.#status().phones });
    }

    // 查询日志 / 状态 / 设置
    if (path === '/api/queries' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
      return this.#json(res, 200, { queries: this.dns.getRecentQueries(limit) });
    }
    if (path === '/api/status' && method === 'GET') {
      return this.#json(res, 200, this.#status());
    }
    if (path === '/api/settings' && method === 'POST') {
      const body = await this.#readBody(req, lang);
      if (body.upstream) {
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(body.upstream)) {
          return this.#json(res, 400, { error: lang === 'zh' ? '上游 DNS 需为 IPv4 地址' : 'Upstream DNS must be an IPv4 address' });
        }
        this.dns.setUpstream(body.upstream);
      }
      return this.#json(res, 200, this.#status());
    }
    if (path === '/api/reset' && method === 'POST') {
      this.dns.resetStats();
      return this.#json(res, 200, { ok: true });
    }
    if (path === '/api/cache' && method === 'GET') {
      return this.#json(res, 200, { cache: this.dns.getCacheEntries() });
    }
    if (path === '/api/cache/clear' && method === 'POST') {
      this.dns.clearCache();
      return this.#json(res, 200, { ok: true });
    }

    this.#json(res, 404, { error: lang === 'zh' ? '接口不存在' : 'Endpoint not found' });
  }

  #status() {
    const lanIPs = getLANIPv4s().map((i) => i.address);
    return {
      version: VERSION,
      dns: {
        running: Boolean(this.dns.socket),
        port: this.dns.port,
        wantedPort: this.dns.wantedPort,
        privilegedWarning: this.dns.privilegedWarning,
        upstream: this.dns.upstream,
      },
      web: { port: this.port, demoPort: this.demoPort },
      ips: getLANIPv4s(),
      primaryIP: getPrimaryLANIP(),
      phones: this.dns.getPhoneClients(lanIPs).map((p) => ({
        ...p,
        name: this.devices.get(p.ip),
      })),
      stats: this.dns.getStats(),
      rulesCount: this.rules.list().length,
    };
  }

  // ── SSE ─────────────────────────────────────────────
  #handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
  }

  #broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(data); } catch { this.sseClients.delete(res); }
    }
  }

  // ── 静态资源 ────────────────────────────────────────
  #serveStatic(path, res) {
    let rel = path === '/' ? '/index.html' : path;
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) {
      return this.#notFound(res);
    }
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return this.#notFound(res);
    } catch {
      // SPA 回退：非静态资源路径返回首页（hash 路由本身不需要，但直接访问 /guide 之类时友好）
      return this.#serveFile(join(PUBLIC_DIR, 'index.html'), res);
    }
    this.#serveFile(file, res);
  }

  #serveFile(file, res) {
    if (!existsSync(file)) return this.#notFound(res);
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 本地工具：始终返回最新前端，避免改版后浏览器用旧缓存
    });
    res.end(readFileSync(file));
  }

  #notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }

  // ── 80 端口劫持演示页 ───────────────────────────────
  #serveHijackPage(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const lang = detectLang(req, url);
    const zh = lang === 'zh';
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    const lanIP = getPrimaryLANIP();
    const rule = host ? this.rules.match(host) : null;
    const hijacked = rule && rule.action === 'hijack' && rule.ip === lanIP;
    const panelURL = lanIP ? `http://${lanIP}:${this.port}/` : `http://<本机IP>:${this.port}/`;

    const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

    const title = hijacked
      ? (zh ? '此域名已被 DNS 劫持' : 'This domain has been DNS-hijacked')
      : (zh ? 'DNS Lab 演示页' : 'DNS Lab demo page');
    const lead = hijacked
      ? (zh
          ? `你要访问的 <code>${escape(host)}</code> 并没有到达真实服务器。<br>DNS Lab 把它的解析结果劫持到了这台电脑（${escape(lanIP || '本机')}）。`
          : `Your request for <code>${escape(host)}</code> never reached the real server.<br>DNS Lab hijacked its resolution to this computer (${escape(lanIP || 'localhost')}).`)
      : (zh
          ? `这是 DNS Lab 的 80 端口演示页。当你添加了「劫持」规则并把手机 DNS 指向这台电脑后，<br>被劫持域名在手机浏览器打开的就是这个页面。`
          : `This is DNS Lab’s port-80 demo page. Once you add a “hijack” rule and point your phone’s DNS at this computer,<br>opening a hijacked domain on the phone shows exactly this page.`);
    const ruleLabel = zh ? '命中规则：' : 'Matched rule: ';
    const cta = zh ? '打开 DNS Lab 控制台' : 'Open the DNS Lab console';
    const foot = zh ? 'DNS Lab · 仅用于本地学习与授权测试' : 'DNS Lab · for local learning and authorised testing only';
    const switchLang = zh ? 'en' : 'zh';
    const switchLabel = zh ? 'English' : '中文';

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0D0F11; color: #E7EBE2;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 24px;
  }
  .card {
    max-width: 560px; width: 100%; text-align: center;
    background: #14171A; border: 1px solid #2A1E1E; border-top: 3px solid #FB5C7D;
    border-radius: 16px; padding: 48px 32px;
  }
  .glyph { font-size: 44px; margin-bottom: 16px; }
  h1 { font-size: 24px; letter-spacing: 1px; margin-bottom: 20px; }
  h1.warn { color: #FB5C7D; }
  p { line-height: 1.9; color: #9AA6A0; font-size: 15px; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: #1D2226; padding: 2px 8px; border-radius: 6px; color: #4ADE80; font-size: 14px;
  }
  .rule { margin: 20px 0; padding: 14px; background: #1D2226; border-radius: 10px; font-size: 14px; }
  .rule .k { color: #8A938E; }
  .rule .v { color: #FBBF24; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .cta {
    display: inline-block; margin-top: 24px; text-decoration: none;
    background: #34D399; color: #0D0F11; font-weight: 600;
    padding: 12px 28px; border-radius: 10px; font-size: 15px;
  }
  .foot { margin-top: 28px; font-size: 12px; color: #5C6660; }
</style>
</head>
<body>
  <div class="card">
    <div class="glyph">${hijacked ? '🚨' : '🧪'}</div>
    <h1 class="${hijacked ? 'warn' : ''}">${escape(title)}</h1>
    <p>${lead}</p>
    ${rule ? `<div class="rule">
      <span class="k">${escape(ruleLabel)}</span><span class="v">${escape(rule.domain)}</span>
      &nbsp;→&nbsp; <span class="v">${escape(rule.ip || rule.action)}</span>
    </div>` : ''}
    <a class="cta" href="${escape(panelURL)}">${escape(cta)}</a>
    <p class="foot">${escape(foot)} · <a href="?lang=${switchLang}" style="color:inherit">${escape(switchLabel)}</a></p>
  </div>
</body>
</html>`);
  }
}
