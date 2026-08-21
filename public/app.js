/* DNS Lab 控制台 — 状态、路由、实时事件与各页渲染 */
'use strict';

/* ── 工具 ─────────────────────────────────── */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const fmtTime = (ts) => {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const fmtRel = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

const ACTION_META = {
  forward:   { label: '转发',   color: 'var(--c-forward)' },
  cache:     { label: '缓存',   color: 'var(--c-cache)' },
  hijack:    { label: '劫持',   color: 'var(--c-hijack)' },
  pollute:   { label: '污染',   color: 'var(--c-pollute)' },
  nxdomain:  { label: '不存在', color: 'var(--c-nxdomain)' },
  drop:      { label: '丢弃',   color: 'var(--c-drop)' },
  error:     { label: '错误',   color: 'var(--c-error)' },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, type = 'ok') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type === 'ok' ? '' : type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

async function copyText(text, tip = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(tip);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(tip);
  }
}

/* ── 全局状态 ─────────────────────────────── */
const state = {
  status: null,
  stats: null,
  queries: [],
  rules: [],
  presets: [],
  page: 'dashboard',
  ledgerPaused: false,
  ledgerFilter: 'all',
  ledgerSearch: '',
  clientFilter: null, // 按设备（客户端 IP）过滤账本
  obDismissed: localStorage.getItem('dnslab.ob-dismissed') === '1',
  obIpSeen: false,
  celebrateDone: false,
};

const localIPs = () => (state.status?.ips || []).map((i) => i.address);
const isPhoneClient = (client) =>
  client && !client.startsWith('127.') && client !== '::1' && !localIPs().includes(client);

/* ── 路由 ─────────────────────────────────── */
const PAGE_TITLES = {
  dashboard: '仪表盘',
  rules: '劫持规则',
  guide: '连接引导',
  settings: '设置',
};

function handleRoute() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  const page = PAGE_TITLES[hash] ? hash : 'dashboard';
  state.page = page;
  $$('.page').forEach((el) => { el.hidden = el.id !== `page-${page}`; });
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = PAGE_TITLES[page];
  if (page === 'guide' && window.Guide) window.Guide.render();
  if (page === 'settings') renderSettings();
}

/* ── 顶栏与横幅 ───────────────────────────── */
function renderTopbar() {
  const s = state.status;
  if (!s) return;
  const dnsOk = s.dns.running && !s.dns.privilegedWarning;
  const box = $('#topbar-status');
  box.innerHTML = `
    <span class="pill ${dnsOk ? '' : 'bad'}"><i class="dot"></i>DNS ${esc(s.dns.port)} 端口</span>
    <span class="pill">上游 <b>${esc(s.dns.upstream)}</b></span>
    <span class="pill conn" id="conn-slot"></span>
    ${s.primaryIP ? `<span class="pill click" id="pill-ip" title="点击复制">本机 <b>${esc(s.primaryIP)}</b></span>` : ''}
  `;
  const ipPill = $('#pill-ip');
  if (ipPill) ipPill.onclick = () => copyText(s.primaryIP, `已复制 ${s.primaryIP}`);
  $('#foot-version').textContent = `DNS Lab v${s.version}`;
  renderConnStatus();
}

/** 手机客户端快照：服务端列表 + 本地最新查询合并（SSE 新事件即时生效）；在线优先、活跃度排序 */
function phoneSnapshot() {
  const now = Date.now();
  const map = new Map();
  for (const p of state.status?.phones || []) map.set(p.ip, { ...p });
  for (const q of state.queries) {
    if (!isPhoneClient(q.client)) continue;
    const p = map.get(q.client) ?? { ip: q.client, name: null, firstDomain: null, queries: 0 };
    if (q.ts > (p.lastSeen ?? 0)) p.lastSeen = q.ts;
    map.set(q.client, p);
  }
  for (const p of map.values()) p.online = now - (p.lastSeen ?? 0) < 120_000;
  return [...map.values()].sort((a, b) =>
    (b.online - a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/** 设备名映射（IP → 备注） */
function deviceNames() {
  const m = {};
  for (const p of state.status?.phones || []) if (p.name) m[p.ip] = p.name;
  return m;
}

function displayClient(ip) {
  return deviceNames()[ip] || ip;
}

/** 顶栏手机连接状态 + 包流图手机节点点亮 */
function renderConnStatus() {
  const el = $('#conn-slot');
  if (!el) return;
  const phones = phoneSnapshot();
  const online = phones.filter((p) => p.online);
  const phoneNode = document.querySelector('.wire-node.phone');
  if (online.length > 0) {
    el.className = 'pill conn ok click';
    el.title = online.map((p) =>
      `${p.name ? `${p.name} · ` : ''}${p.ip} · ${fmtRel(p.lastSeen)}`).join('\n') + '\n点击管理设备';
    el.innerHTML = `<i class="dot"></i>已连接 <b>${online.length}</b> 台手机`;
  } else if (phones.length > 0) {
    el.className = 'pill conn off click';
    el.title = phones.map((p) => `${p.name ? `${p.name} · ` : ''}${p.ip}`).join(', ') + '\n点击管理设备';
    el.innerHTML = '<i class="dot"></i>手机已离线';
  } else {
    el.className = 'pill conn off click';
    el.innerHTML = '<i class="dot"></i>等待手机连接';
  }
  el.onclick = toggleDevicePanel;
  if (phoneNode) phoneNode.classList.toggle('live', online.length > 0);
  // 编辑设备名时跳过面板重渲染，避免输入框被重建导致 blur 误提交
  if (popoverEl && !editingDevice) renderDevicePanel();
}

/* ── 设备面板（多设备管理：状态 / 改名 / 按设备筛选） ─── */
let popoverEl = null;

function toggleDevicePanel() {
  if (popoverEl) closeDevicePanel();
  else openDevicePanel();
}

function openDevicePanel() {
  popoverEl = document.createElement('div');
  popoverEl.className = 'dev-popover';
  document.body.appendChild(popoverEl);
  const pill = $('#conn-slot');
  const rect = pill?.getBoundingClientRect();
  if (rect) {
    popoverEl.style.top = `${rect.bottom + 8}px`;
    popoverEl.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  }
  renderDevicePanel();
  setTimeout(() => document.addEventListener('mousedown', onOutsideClick, true), 0);
}

function closeDevicePanel() {
  popoverEl?.remove();
  popoverEl = null;
  document.removeEventListener('mousedown', onOutsideClick, true);
}

function onOutsideClick(e) {
  const pill = $('#conn-slot');
  if (popoverEl && !popoverEl.contains(e.target) && pill && !pill.contains(e.target)) {
    closeDevicePanel();
  }
}

function phoneRecentStats(ip) {
  const qs = state.queries.filter((q) => q.client === ip);
  const interfered = qs.filter((q) =>
    ['hijack', 'pollute', 'nxdomain', 'drop'].includes(q.action)).length;
  return { total: qs.length, interfered };
}

function renderDevicePanel() {
  if (!popoverEl) return;
  const phones = phoneSnapshot();
  if (phones.length === 0) {
    popoverEl.innerHTML = `
      <div class="dev-pop-head">已接入设备</div>
      <div class="dev-empty">还没有设备接入。<br>按「连接引导」配置手机后会出现在这里。</div>`;
    return;
  }
  const rows = phones.map((p) => {
    const st = phoneRecentStats(p.ip);
    const editing = editingDevice === p.ip;
    return `
    <div class="dev-row">
      <div class="dev-main">
        <span class="dev-dot ${p.online ? 'on' : ''}"></span>
        <div class="dev-info">
          <div class="dev-name">
            ${editing ? `
              <input class="dev-name-input" data-dev-input="${esc(p.ip)}" value="${esc(p.name || '')}" maxlength="30" placeholder="给这台设备起个名">
            ` : `<b data-dev-name="${esc(p.ip)}">${esc(p.name || p.ip)}</b>`}
            <button class="icon-btn" data-rename="${esc(p.ip)}" title="${p.name ? '修改备注名' : '添加备注名'}" type="button">
              <svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="dev-meta mono">${esc(p.ip)}${p.firstDomain ? ` · 首查 ${esc(p.firstDomain)}` : ''}</div>
          <div class="dev-meta">
            ${p.online ? `<span class="dev-on">在线</span> · ${fmtRel(p.lastSeen)}` : `离线 · 最后活跃 ${fmtRel(p.lastSeen)}`}
            · 累计 ${p.queries ?? 0} 条${st.total ? ` · 近期被干预 ${st.interfered}/${st.total}` : ''}
          </div>
        </div>
      </div>
      ${state.clientFilter === p.ip
        ? `<button class="btn tiny" data-only="${esc(p.ip)}" type="button">取消筛选</button>`
        : `<button class="btn tiny ghost" data-only="${esc(p.ip)}" type="button">只看此设备</button>`}
    </div>`;
  }).join('');
  popoverEl.innerHTML = `
    <div class="dev-pop-head">已接入设备 · ${phones.length}<span class="dev-pop-hint">在线 ${phones.filter((p) => p.online).length}</span></div>
    ${rows}`;

  // 改名：进入 / 保存 / 取消
  popoverEl.querySelectorAll('[data-rename]').forEach((b) => {
    b.onclick = () => {
      editingDevice = b.dataset.rename;
      renderDevicePanel();
      popoverEl.querySelector(`[data-dev-input="${CSS.escape(editingDevice)}"]`)?.focus();
    };
  });
  const input = popoverEl.querySelector('[data-dev-input]');
  if (input) {
    const save = async () => {
      const ip = input.dataset.devInput;
      const name = input.value.trim();
      editingDevice = null;
      try {
        await api(`/api/devices/${ip}`, { method: 'PATCH', body: { name } });
        await refreshStatus();
        toast(name ? `已命名为「${name}」` : '已清除备注名');
      } catch (e) { toast(e.message, 'error'); }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { editingDevice = null; renderDevicePanel(); }
    };
    input.onblur = () => { if (editingDevice) save(); };
  }
  // 只看此设备 / 取消筛选
  popoverEl.querySelectorAll('[data-only]').forEach((b) => {
    b.onclick = () => {
      const ip = b.dataset.only;
      state.clientFilter = state.clientFilter === ip ? null : ip;
      closeDevicePanel();
      if (state.page !== 'dashboard') location.hash = '#/dashboard';
      else { renderLedger(); }
      renderClientChip();
    };
  });
}

let editingDevice = null;

function renderBanners() {
  const s = state.status;
  const slot = $('#banner-slot');
  if (!s) { slot.innerHTML = ''; return; }
  const banners = [];

  if (s.dns.privilegedWarning) {
    banners.push(`
      <div class="banner warn">
        <span>⚠️</span>
        <div>
          DNS 端口 <code>${s.dns.wantedPort}</code> 无权限绑定，当前运行在 <code>${s.dns.port}</code>。
          手机的「手动 DNS」只支持 53 端口——请复制以下命令重启服务：
          <div style="margin-top:6px"><code>sudo node server/index.js</code></div>
        </div>
        <button class="btn tiny ghost" id="banner-copy-sudo" type="button">复制命令</button>
      </div>`);
  }
  if (!s.web.demoPort && s.rulesCount !== undefined) {
    banners.push(`
      <div class="banner info">
        <span>ℹ️</span>
        <div>80 端口未监听（需以 sudo 运行）。「劫持跳转演示」预设的手机端跳转效果不可用，其余功能不受影响。</div>
      </div>`);
  }
  if (!s.primaryIP) {
    banners.push(`
      <div class="banner bad">
        <span>⛔</span>
        <div>未检测到局域网 IPv4。请检查 Wi-Fi / 网线连接，否则手机无法把 DNS 指向本机。</div>
      </div>`);
  }
  slot.innerHTML = banners.join('');
  const copyBtn = $('#banner-copy-sudo');
  if (copyBtn) copyBtn.onclick = () => copyText('sudo node server/index.js', '已复制，请在终端执行');
}

/* ── 签名元素：包流动画 ───────────────────── */
let activeDots = 0;

function spawnDot(lineEl, color, reverse = false, duration = 620) {
  if (!lineEl || activeDots > 26) return Promise.resolve();
  activeDots++;
  return new Promise((resolve) => {
    const dot = document.createElement('div');
    dot.className = 'wire-dot';
    dot.style.color = color;
    dot.style.background = color;
    dot.style.transition = `left ${duration}ms linear`;
    dot.style.left = reverse ? '100%' : '0%';
    lineEl.appendChild(dot);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      dot.style.left = reverse ? '0%' : '100%';
    }));
    setTimeout(() => { dot.remove(); activeDots--; resolve(); }, duration + 40);
  });
}

function wireFlow(action) {
  const line1 = $('#wire-line-1');
  const line2 = $('#wire-line-2');
  const color = ACTION_META[action]?.color || 'var(--ink)';
  line1?.classList.add('on');
  setTimeout(() => line1?.classList.remove('on'), 700);

  const p = spawnDot(line1, '#C9D4CC'); // 请求：手机 → Lab
  if (action === 'forward') {
    p.then(() => spawnDot(line2, '#C9D4CC'))
      .then(() => { line2?.classList.add('on'); setTimeout(() => line2?.classList.remove('on'), 700); })
      .then(() => spawnDot(line2, color, true))
      .then(() => spawnDot(line1, color, true));
  } else if (action === 'cache' || action === 'error') {
    p.then(() => spawnDot(line1, color, true));
  } else if (action !== 'drop') { // hijack / pollute / nxdomain：在 Lab 处直接裁决并折返
    p.then(() => spawnDot(line1, color, true));
  }
}

/* ── 统计卡 ───────────────────────────────── */
function renderStats() {
  const st = state.stats;
  if (!st) return;
  const cards = [
    { label: '总查询', num: st.total, color: 'var(--ink)' },
    { label: '正常转发', num: st.forward, color: 'var(--c-forward)' },
    { label: '缓存命中', num: st.cache, color: 'var(--c-cache)' },
    { label: '已劫持', num: st.hijack, color: 'var(--c-hijack)' },
    { label: '已污染', num: st.pollute, color: 'var(--c-pollute)' },
    { label: '拦截 / 丢弃', num: st.nxdomain + st.drop, color: 'var(--c-nxdomain)' },
  ];
  $('#stats-row').innerHTML = cards.map((c) => `
    <div class="stat" style="--accent:${c.color}">
      <div class="num" style="color:${c.color === 'var(--ink)' ? 'var(--ink)' : c.color}">${c.num}</div>
      <div class="label">${c.label}</div>
    </div>`).join('');
}

/* ── 开始使用（引导检查单） ───────────────── */
function obSteps() {
  const s = state.status;
  const phoneQuery = state.queries.find((q) => isPhoneClient(q.client));
  const interfered = state.queries.some((q) =>
    ['hijack', 'pollute', 'nxdomain', 'drop'].includes(q.action));
  return [
    {
      title: '启动 DNS 服务',
      desc: s?.dns.running ? `DNS 已在 ${s.dns.port} 端口监听` : '等待服务启动',
      done: Boolean(s?.dns.running && !s.dns.privilegedWarning),
      tip: s?.dns.running ? `udp://0.0.0.0:${s.dns.port}` : null,
    },
    {
      title: '确认手机与电脑在同一 Wi-Fi',
      desc: '查看下方本机 IP，稍后在手机上填写同一个网段的地址',
      done: state.obIpSeen,
      tip: s?.primaryIP ? `本机 IP：${s.primaryIP}` : null,
      btn: state.obIpSeen ? null : { label: '我已确认', key: 'ip-seen' },
    },
    {
      title: '手机把 DNS 设为本机 IP',
      desc: phoneQuery
        ? `已收到来自 ${phoneQuery.client} 的查询，连接成功`
        : '等待来自手机的第一条查询…（设置方法见「连接引导」页）',
      done: Boolean(phoneQuery),
      tip: phoneQuery ? `首条查询：${phoneQuery.domain}` : null,
      link: phoneQuery ? null : { label: '查看图文步骤', href: '#/guide' },
    },
    {
      title: '添加一条劫持规则',
      desc: '在「劫持规则」页添加规则或应用预设',
      done: state.rules.length > 0,
      link: state.rules.length > 0 ? null : { label: '去添加规则', href: '#/rules' },
    },
    {
      title: '在手机上验证效果',
      desc: interfered
        ? '已有被干预的查询，去账本看看判决结果吧'
        : '对劫持/污染域名发起查询（打开网页或 dig），观察账本变化',
      done: interfered,
    },
  ];
}

function renderOnboarding() {
  const box = $('#onboarding');
  const steps = obSteps();
  const allDone = steps.every((s) => s.done);
  if (state.obDismissed || (allDone && state.celebrateDone)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const firstDoing = steps.findIndex((s) => !s.done);
  $('#onboarding-steps').innerHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : i === firstDoing ? 'doing' : '';
    const btn = s.btn ? `<button class="btn tiny" data-ob="${s.btn.key}" type="button">${s.btn.label}</button>` : '';
    const link = s.link ? `<a class="btn tiny" href="${s.link.href}">${s.link.label}</a>` : '';
    return `
      <li class="step ${cls}">
        <span class="step-mark"></span>
        <div class="step-body">
          <b>${s.title}</b>
          <p>${esc(s.desc)}</p>
          ${s.tip ? `<div class="step-tip">${esc(s.tip)}</div>` : ''}
        </div>
        ${btn}${link}
      </li>`;
  }).join('');
  $$('#onboarding-steps [data-ob]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.ob === 'ip-seen') { state.obIpSeen = true; renderOnboarding(); }
    };
  });
  if (allDone && !state.celebrateDone) {
    state.celebrateDone = true;
    toast('全部步骤完成，实验环境就绪 🎉');
    renderOnboarding();
  }
}

/* ── 查询账本 ─────────────────────────────── */
const FILTER_CHIPS = ['all', 'forward', 'hijack', 'pollute', 'nxdomain', 'drop'];
const FILTER_LABEL = { all: '全部', forward: '转发', hijack: '劫持', pollute: '污染', nxdomain: '拦截', drop: '丢弃' };

function initLedgerTools() {
  const chips = FILTER_CHIPS.map((k) =>
    `<button class="chip" data-filter="${k}" style="--accent:${k === 'all' ? 'var(--brand)' : ACTION_META[k]?.color}">${FILTER_LABEL[k]}</button>`).join('');
  $('#ledger-filter').innerHTML = chips;
  $$('#ledger-filter .chip').forEach((c) => {
    c.onclick = () => {
      state.ledgerFilter = c.dataset.filter;
      $$('#ledger-filter .chip').forEach((x) => x.classList.toggle('on', x === c));
      renderLedger();
    };
  });
  $('#ledger-filter .chip').classList.add('on');

  $('#ledger-search').addEventListener('input', (e) => {
    state.ledgerSearch = e.target.value.trim().toLowerCase();
    renderLedger();
  });
  $('#client-filter-chip').onclick = () => {
    state.clientFilter = null;
    renderLedger();
  };
  // 客户端列点击 → 按设备筛选（事件委托，覆盖全量渲染与新增行）
  $('#ledger-body').addEventListener('click', (e) => {
    const cell = e.target.closest('.client-cell');
    if (!cell) return;
    state.clientFilter = state.clientFilter === cell.dataset.client ? null : cell.dataset.client;
    renderLedger();
  });
  $('#ledger-pause').onclick = () => {
    state.ledgerPaused = !state.ledgerPaused;
    $('#ledger-pause').textContent = state.ledgerPaused ? '恢复滚动' : '暂停滚动';
  };
  $('#ledger-clear').onclick = async () => {
    try { await api('/api/reset', { method: 'POST' }); state.queries = []; renderLedger(); renderStats(); toast('已清空日志与统计'); }
    catch (e) { toast(e.message, 'error'); }
  };
}

function queryMatches(q) {
  if (state.ledgerFilter !== 'all' && q.action !== state.ledgerFilter) return false;
  if (state.clientFilter && q.client !== state.clientFilter) return false;
  if (state.ledgerSearch) {
    const hay = `${q.domain} ${q.client} ${displayClient(q.client)} ${q.ips.join(' ')}`.toLowerCase();
    if (!hay.includes(state.ledgerSearch)) return false;
  }
  return true;
}

function ledgerRow(q, fresh = false) {
  const meta = ACTION_META[q.action] || ACTION_META.error;
  const answer = q.ips.length ? q.ips.slice(0, 3).map(esc).join('<br>') : '<span class="t-dim">—</span>';
  const clientName = displayClient(q.client);
  const clientActive = state.clientFilter === q.client;
  return `
    <tr class="${fresh ? 'fresh' : ''}">
      <td class="t-dim mono">${fmtTime(q.ts)}</td>
      <td><button class="client-cell mono ${clientActive ? 'on' : ''}" data-client="${esc(q.client)}" title="${clientName === q.client ? '点击只看此设备' : `${esc(q.client)} · 点击只看此设备`}" type="button">${esc(clientName)}</button></td>
      <td class="t-domain mono">${esc(q.domain)}</td>
      <td class="mono t-dim">${esc(q.type)}</td>
      <td><span class="badge" data-action="${q.action}"><i></i>${meta.label}</span></td>
      <td class="mono">${answer}</td>
      <td class="t-dim mono">${q.latency}ms</td>
    </tr>`;
}

function renderLedger() {
  const rows = state.queries.filter(queryMatches).slice(0, 150);
  $('#ledger-body').innerHTML = rows.map((q) => ledgerRow(q)).join('');
  $('#ledger-empty').hidden = rows.length > 0;
  $$('.js-ip').forEach((el) => { el.textContent = state.status?.primaryIP || '本机IP'; });
  renderClientChip();
  updateLedgerHint();
}

/** 当前设备筛选的 chip（显示设备名，点击 ✕ 清除） */
function renderClientChip() {
  const chip = $('#client-filter-chip');
  if (!chip) return;
  if (!state.clientFilter) {
    chip.hidden = true;
    chip.classList.remove('on');
    chip.removeAttribute('title');
    chip.style.removeProperty('--accent');
    chip.textContent = '';
    return;
  }
  chip.hidden = false;
  chip.classList.add('on');
  chip.style.setProperty('--accent', 'var(--brand)');
  chip.innerHTML = `📱 ${esc(displayClient(state.clientFilter))}&nbsp;✕`;
  chip.title = `${state.clientFilter} · 点击取消设备筛选`;
}

function updateLedgerHint() {
  const total = state.queries.length;
  if (!total) { $('#ledger-hint').textContent = ''; return; }
  const filtered = state.ledgerFilter !== 'all' || state.ledgerSearch || state.clientFilter;
  const shown = state.queries.filter(queryMatches).length;
  const devPart = state.clientFilter ? `${displayClient(state.clientFilter)} · ` : '';
  $('#ledger-hint').textContent = filtered
    ? `${devPart}显示 ${shown} / 共 ${total} 条 · 实时更新`
    : `共 ${total} 条记录 · 实时更新`;
}

function onNewQuery(entry) {
  state.queries.unshift(entry);
  if (state.queries.length > 500) state.queries.pop();
  wireFlow(entry.action);
  if (window.Guide) window.Guide.onQuery(entry);
  if (isPhoneClient(entry.client)) renderConnStatus();
  if (state.page === 'dashboard') {
    if (!state.ledgerPaused && queryMatches(entry)) {
      const tbody = $('#ledger-body');
      tbody.insertAdjacentHTML('afterbegin', ledgerRow(entry, true));
      while (tbody.children.length > 150) tbody.lastElementChild.remove();
      $('#ledger-empty').hidden = true;
    }
    updateLedgerHint();
    renderOnboarding();
  }
}

/* ── 规则页 ───────────────────────────────── */
function renderPresets() {
  const s = state.status;
  const demoReady = Boolean(s?.web?.demoPort && s?.primaryIP);
  $('#presets-row').innerHTML = state.presets.map((p) => {
    const applied = p.rules.filter((r) => state.rules.some((x) => x.domain === r.domain)).length;
    const total = p.rules.length;
    const full = applied === total;
    const canRemove = applied > 0;
    const actionBtn = full
      ? `<button class="btn tiny ghost danger" data-preset-remove="${p.key}" type="button">移除预设</button>`
      : `<button class="btn tiny primary" data-preset-apply="${p.key}" type="button" ${p.key === 'hijack-demo' && !demoReady ? 'disabled title="需要 sudo 运行（80 端口）且检测到局域网 IP"' : ''}>${applied > 0 ? '补全规则' : '一键应用'}</button>`;
    return `
      <div class="preset ${p.key === 'hijack-demo' && !demoReady ? 'unavailable' : ''}">
        <h3>
          <span class="badge" data-action="${p.key === 'hijack-demo' ? 'hijack' : p.key === 'gfw' ? 'pollute' : 'nxdomain'}"><i></i>${esc(p.name.split('：')[0])}</span>
        </h3>
        <p>${esc(p.description)}</p>
        <div class="foot">
          <span class="count">${canRemove ? `已应用 ${applied}/${total}` : `${total} 条规则`}</span>
          ${actionBtn}
        </div>
      </div>`;
  }).join('');

  $$('[data-preset-apply]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/presets/${b.dataset.presetApply}/apply`, { method: 'POST' });
        toast(`预设已应用：新增 ${r.added} 条${r.skipped ? `，跳过 ${r.skipped} 条已存在` : ''}`);
      } catch (e) { toast(e.message, 'error'); }
      await refreshRules();
    };
  });
  $$('[data-preset-remove]').forEach((b) => {
    b.onclick = async () => {
      const preset = state.presets.find((p) => p.key === b.dataset.presetRemove);
      try {
        const r = await api('/api/rules/clear', { method: 'POST', body: { note: preset?.rules[0]?.note } });
        toast(`已移除 ${r.removed} 条预设规则`);
      } catch (e) { toast(e.message, 'error'); }
      await refreshRules();
    };
  });
}

function renderRules() {
  const tbody = $('#rules-body');
  const rules = state.rules;
  $('#rules-empty').hidden = rules.length > 0;
  $('#rules-clear').hidden = rules.length === 0;
  $('#rules-hint').textContent = rules.length ? `${rules.length} 条规则 · 按列表顺序匹配，先命中先生效` : '';
  $('#nav-rule-count').hidden = rules.length === 0;
  $('#nav-rule-count').textContent = rules.length;
  tbody.innerHTML = rules.map((r) => `
    <tr>
      <td class="t-domain mono">${esc(r.domain)}</td>
      <td><span class="badge" data-action="${r.action}"><i></i>${ACTION_META[r.action]?.label || r.action}</span></td>
      <td class="mono">${r.action === 'hijack' ? esc(r.ip) : '<span class="t-dim">—</span>'}</td>
      <td class="t-dim">${r.note ? esc(r.note) : '—'}</td>
      <td>
        <label class="switch">
          <input type="checkbox" data-rule-toggle="${r.id}" ${r.enabled ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </td>
      <td>
        <button class="icon-btn" data-rule-del="${r.id}" title="删除规则" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </td>
    </tr>`).join('');

  $$('[data-rule-toggle]').forEach((el) => {
    el.onchange = async () => {
      try {
        await api(`/api/rules/${el.dataset.ruleToggle}`, { method: 'PATCH', body: { enabled: el.checked } });
        await refreshRules(false);
      } catch (e) { toast(e.message, 'error'); }
    };
  });
  $$('[data-rule-del]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api(`/api/rules/${el.dataset.ruleDel}`, { method: 'DELETE' });
        toast('规则已删除');
        await refreshRules();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function refreshRules(rerenderPresets = true) {
  const r = await api('/api/rules');
  state.rules = r.rules;
  renderRules();
  if (rerenderPresets) renderPresets();
  renderOnboarding();
}

function initRuleForm() {
  const actionSel = $('#in-action');
  const ipField = $('#f-ip');
  const syncIpField = () => {
    ipField.style.display = actionSel.value === 'hijack' ? '' : 'none';
  };
  actionSel.addEventListener('change', syncIpField);
  syncIpField();

  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $$('.field').forEach((f) => f.classList.remove('err'));
    try {
      await api('/api/rules', {
        method: 'POST',
        body: {
          domain: $('#in-domain').value.trim(),
          action: actionSel.value,
          ip: $('#in-ip').value.trim(),
          note: $('#in-note').value.trim(),
        },
      });
      toast('规则已添加');
      $('#in-domain').value = '';
      $('#in-ip').value = '';
      $('#in-note').value = '';
      await refreshRules();
    } catch (err) {
      const msg = err.message;
      const domainField = $('#f-domain');
      const ipFieldEl = $('#f-ip');
      if (msg.includes('IP') || msg.includes('ip')) {
        ipFieldEl.classList.add('err');
        ipFieldEl.querySelector('.field-err').textContent = msg;
      } else {
        domainField.classList.add('err');
        domainField.querySelector('.field-err').textContent = msg;
      }
      toast(msg, 'error');
    }
  });

  $('#rules-clear').onclick = async () => {
    if (!confirm('确定删除全部规则？该操作不可撤销。')) return;
    try {
      await api('/api/rules/clear', { method: 'POST' });
      toast('已删除全部规则');
      await refreshRules();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ── 设置页 ───────────────────────────────── */
const UPSTREAMS = [
  { ip: '114.114.114.114', name: '114 公共 DNS' },
  { ip: '223.5.5.5', name: '阿里 AliDNS' },
  { ip: '119.29.29.29', name: '腾讯 DNSPod' },
  { ip: '8.8.8.8', name: 'Google DNS' },
  { ip: '1.1.1.1', name: 'Cloudflare' },
];

function renderSettings() {
  const cur = state.status?.dns?.upstream;
  $('#upstream-grid').innerHTML = UPSTREAMS.map((u) => `
    <button class="upstream-opt ${u.ip === cur ? 'on' : ''}" data-upstream="${u.ip}" type="button">
      <span class="ip">${u.ip}</span>
      <span class="name">${u.name}</span>
    </button>`).join('');
  $$('#upstream-grid .upstream-opt').forEach((b) => {
    b.onclick = async () => {
      try {
        const s = await api('/api/settings', { method: 'POST', body: { upstream: b.dataset.upstream } });
        state.status = s;
        renderTopbar(); renderSettings();
        toast(`上游已切换为 ${b.dataset.upstream}`);
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function initSettingsActions() {
  $$('#page-settings [data-action]').forEach((btn) => {
    let armed = false;
    btn.onclick = async () => {
      if (!armed) {
        armed = true;
        const origin = btn.textContent;
        btn.textContent = '再次点击确认';
        setTimeout(() => { armed = false; btn.textContent = origin; }, 2600);
        return;
      }
      armed = false;
      try {
        if (btn.dataset.action === 'reset-stats') {
          await api('/api/reset', { method: 'POST' });
          state.queries = []; renderLedger(); renderStats(); toast('已清空日志与统计');
        } else if (btn.dataset.action === 'clear-cache') {
          await api('/api/cache/clear', { method: 'POST' });
          toast('解析缓存已清空');
        } else if (btn.dataset.action === 'clear-rules') {
          await api('/api/rules/clear', { method: 'POST' });
          toast('已删除全部规则');
          await refreshRules();
        }
      } catch (e) { toast(e.message, 'error'); }
      btn.textContent = { 'reset-stats': '清空', 'clear-cache': '清空', 'clear-rules': '全部删除' }[btn.dataset.action];
    };
  });

  $('#upstream-custom').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ip = $('#upstream-input').value.trim();
    if (!ip) return;
    try {
      const s = await api('/api/settings', { method: 'POST', body: { upstream: ip } });
      state.status = s;
      renderTopbar(); renderSettings();
      $('#upstream-input').value = '';
      toast(`上游已切换为 ${ip}`);
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ── SSE 实时事件 ─────────────────────────── */
function connectSSE() {
  const es = new EventSource('/api/events');
  const pill = $('#sse-pill');
  es.onopen = () => { pill.classList.remove('off'); pill.querySelector('span').textContent = '实时连接中'; };
  es.onerror = () => { pill.classList.add('off'); pill.querySelector('span').textContent = '实时连接已断开，重连中…'; };
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'query') onNewQuery(msg.data);
    else if (msg.type === 'stats') { state.stats = msg.data; renderStats(); }
    else if (msg.type === 'rules') { state.rules = msg.data; renderRules(); renderPresets(); renderOnboarding(); }
    else if (msg.type === 'status-changed') refreshStatus();
  };
}

async function refreshStatus() {
  try {
    const prevNames = JSON.stringify(deviceNames());
    state.status = await api('/api/status');
    state.stats = state.status.stats;
    renderTopbar(); renderBanners(); renderStats(); renderOnboarding(); renderConnStatus();
    if (JSON.stringify(deviceNames()) !== prevNames) renderLedger(); // 设备名变化同步到账本
    if (state.page === 'settings') renderSettings();
  } catch { /* 服务重启中 */ }
}

/* ── 初始化 ───────────────────────────────── */
async function init() {
  $('#onboarding-toggle').onclick = () => {
    state.obDismissed = true;
    localStorage.setItem('dnslab.ob-dismissed', '1');
    $('#onboarding').hidden = true;
  };

  initLedgerTools();
  initRuleForm();
  initSettingsActions();

  // 图例
  $('#wire-legend').innerHTML = ['forward', 'cache', 'hijack', 'pollute', 'nxdomain', 'drop']
    .map((k) => `<span><i style="background:${ACTION_META[k].color}"></i>${ACTION_META[k].label}</span>`).join('');

  const [status, queries, rules, presets] = await Promise.all([
    api('/api/status'), api('/api/queries?limit=300'), api('/api/rules'), api('/api/presets'),
  ]);
  state.status = status;
  state.stats = status.stats;
  state.queries = queries.queries;
  state.rules = rules.rules;
  state.presets = presets.presets;

  renderTopbar(); renderBanners(); renderStats(); renderLedger();
  renderRules(); renderPresets(); renderOnboarding();

  window.addEventListener('hashchange', handleRoute);
  handleRoute();
  connectSSE();

  // 状态巡检：IP 变化 / 端口状态兜底刷新
  setInterval(refreshStatus, 15000);
}

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="banner bad" style="margin:16px"><span>⛔</span><div>控制台初始化失败：${esc(err.message)}<br>请确认 DNS Lab 服务正在运行。</div></div>`);
});

// 暴露给 guide.js 使用
window.App = { state, api, toast, copyText, esc, isPhoneClient, ACTION_META, renderOnboarding };
