/* DNS Lab 控制台 — 状态、路由、实时事件与各页渲染 */
'use strict';

const { t, getLang, setLang } = window.I18n;

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
  if (s < 10) return t('time.now');
  if (s < 60) return t('time.s', { n: s });
  if (s < 3600) return t('time.m', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.h', { n: Math.floor(s / 3600) });
  return t('time.d', { n: Math.floor(s / 86400) });
};

const ACTION_META = {
  forward:   { labelKey: 'action.forward', color: 'var(--c-forward)' },
  cache:     { labelKey: 'action.cache',   color: 'var(--c-cache)' },
  hijack:    { labelKey: 'action.hijack',  color: 'var(--c-hijack)' },
  pollute:   { labelKey: 'action.pollute', color: 'var(--c-pollute)' },
  nxdomain:  { labelKey: 'action.nxdomain',color: 'var(--c-nxdomain)' },
  drop:      { labelKey: 'action.drop',    color: 'var(--c-drop)' },
  error:     { labelKey: 'action.error',   color: 'var(--c-error)' },
};
const actionLabel = (a) => t((ACTION_META[a] || ACTION_META.error).labelKey);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'Accept-Language': getLang() },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('common.reqFail', { n: res.status }));
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

async function copyText(text, tip) {
  tip = tip ?? t('common.copied');
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
function handleRoute() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  const page = ['dashboard', 'rules', 'guide', 'settings'].includes(hash) ? hash : 'dashboard';
  state.page = page;
  $$('.page').forEach((el) => { el.hidden = el.id !== `page-${page}`; });
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  $('#page-title').textContent = t(`nav.${page}`);
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
    <span class="pill ${dnsOk ? '' : 'bad'}"><i class="dot"></i>${esc(t('topbar.dnsPort', { port: s.dns.port }))}</span>
    <span class="pill">${esc(t('topbar.upstream'))} <b>${esc(s.dns.upstream)}</b></span>
    <span class="pill conn" id="conn-slot"></span>
    ${s.primaryIP ? `<span class="pill click" id="pill-ip" title="${esc(t('topbar.copyTitle'))}">${esc(t('topbar.local'))} <b>${esc(s.primaryIP)}</b></span>` : ''}
  `;
  const ipPill = $('#pill-ip');
  if (ipPill) ipPill.onclick = () => copyText(s.primaryIP, t('topbar.copiedIp', { ip: s.primaryIP }));
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
      `${p.name ? `${p.name} · ` : ''}${p.ip} · ${fmtRel(p.lastSeen)}`).join('\n') + `\n${t('conn.manage')}`;
    el.innerHTML = `<i class="dot"></i>${esc(t('conn.connectedPre'))} <b>${online.length}</b> ${esc(t('conn.connectedPost'))}`;
  } else if (phones.length > 0) {
    el.className = 'pill conn off click';
    el.title = phones.map((p) => `${p.name ? `${p.name} · ` : ''}${p.ip}`).join(', ') + `\n${t('conn.manage')}`;
    el.innerHTML = `<i class="dot"></i>${esc(t('conn.offline'))}`;
  } else {
    el.className = 'pill conn off click';
    el.innerHTML = `<i class="dot"></i>${esc(t('conn.waiting'))}`;
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
      <div class="dev-pop-head">${esc(t('dev.title'))}</div>
      <div class="dev-empty">${t('dev.empty')}</div>`;
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
              <input class="dev-name-input" data-dev-input="${esc(p.ip)}" value="${esc(p.name || '')}" maxlength="30" placeholder="${esc(t('dev.ph'))}">
            ` : `<b data-dev-name="${esc(p.ip)}">${esc(p.name || p.ip)}</b>`}
            <button class="icon-btn" data-rename="${esc(p.ip)}" title="${p.name ? esc(t('dev.rename')) : esc(t('dev.addName'))}" type="button">
              <svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <div class="dev-meta mono">${esc(p.ip)}${p.firstDomain ? ` · ${esc(t('dev.first', { d: p.firstDomain }))}` : ''}</div>
          <div class="dev-meta">
            ${p.online ? `<span class="dev-on">${esc(t('dev.on'))}</span> · ${fmtRel(p.lastSeen)}` : `${esc(t('dev.off'))} · ${esc(t('dev.lastSeen', { t: fmtRel(p.lastSeen) }))}`}
            · ${esc(t('dev.total', { n: p.queries ?? 0 }))}${st.total ? ` · ${esc(t('dev.recent', { a: st.interfered, b: st.total }))}` : ''}
          </div>
        </div>
      </div>
      ${state.clientFilter === p.ip
        ? `<button class="btn tiny" data-only="${esc(p.ip)}" type="button">${esc(t('dev.unfilter'))}</button>`
        : `<button class="btn tiny ghost" data-only="${esc(p.ip)}" type="button">${esc(t('dev.only'))}</button>`}
    </div>`;
  }).join('');
  popoverEl.innerHTML = `
    <div class="dev-pop-head">${esc(t('dev.title'))} · ${phones.length}<span class="dev-pop-hint">${esc(t('dev.onlineCount', { n: phones.filter((p) => p.online).length }))}</span></div>
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
        toast(name ? t('dev.named', { n: name }) : t('dev.unnamed'));
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
          ${t('banner.portWarn', { wanted: s.dns.wantedPort, port: s.dns.port })}
          <div style="margin-top:6px"><code>sudo node server/index.js</code></div>
        </div>
        <button class="btn tiny ghost" id="banner-copy-sudo" type="button">${esc(t('banner.copyCmd'))}</button>
      </div>`);
  }
  if (!s.web.demoPort && s.rulesCount !== undefined) {
    banners.push(`
      <div class="banner info">
        <span>ℹ️</span>
        <div>${esc(t('banner.noDemo'))}</div>
      </div>`);
  }
  if (!s.primaryIP) {
    banners.push(`
      <div class="banner bad">
        <span>⛔</span>
        <div>${esc(t('banner.noLan'))}</div>
      </div>`);
  }
  const sus = s.stats?.lastSuspicious;
  if (sus && Date.now() - sus.ts < 120_000) {
    banners.push(`
      <div class="banner bad">
        <span>⚠️</span>
        <div>
          <b>${esc(t('banner.susTitle'))}</b>：${t('banner.susBody', { domain: esc(sus.domain), ip: esc(sus.ip), reason: esc(t(`sus.reason.${sus.reason}`)) })}
          <div style="margin-top:6px" class="t-dim">${esc(t('banner.susFix'))}</div>
        </div>
      </div>`);
  }
  slot.innerHTML = banners.join('');
  const copyBtn = $('#banner-copy-sudo');
  if (copyBtn) copyBtn.onclick = () => copyText('sudo node server/index.js', t('banner.copiedRun'));
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
    { label: t('stats.total'), num: st.total, color: 'var(--ink)' },
    { label: t('stats.forward'), num: st.forward, color: 'var(--c-forward)' },
    { label: t('stats.cache'), num: st.cache, color: 'var(--c-cache)' },
    { label: t('stats.hijack'), num: st.hijack, color: 'var(--c-hijack)' },
    { label: t('stats.pollute'), num: st.pollute, color: 'var(--c-pollute)' },
    { label: t('stats.blocked'), num: st.nxdomain + st.drop, color: 'var(--c-nxdomain)' },
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
      title: t('ob.step1'),
      desc: s?.dns.running ? t('ob.step1done', { port: s.dns.port }) : t('ob.step1wait'),
      done: Boolean(s?.dns.running && !s.dns.privilegedWarning),
      tip: s?.dns.running ? `udp://0.0.0.0:${s.dns.port}` : null,
    },
    {
      title: t('ob.step2'),
      desc: t('ob.step2desc'),
      done: state.obIpSeen,
      tip: s?.primaryIP ? t('ob.step2tip', { ip: s.primaryIP }) : null,
      btn: state.obIpSeen ? null : { label: t('ob.step2btn'), key: 'ip-seen' },
    },
    {
      title: t('ob.step3'),
      desc: phoneQuery
        ? t('ob.step3done', { ip: phoneQuery.client })
        : t('ob.step3wait'),
      done: Boolean(phoneQuery),
      tip: phoneQuery ? t('ob.step3tip', { d: phoneQuery.domain }) : null,
      link: phoneQuery ? null : { label: t('ob.step3link'), href: '#/guide' },
    },
    {
      title: t('ob.step4'),
      desc: t('ob.step4desc'),
      done: state.rules.length > 0,
      link: state.rules.length > 0 ? null : { label: t('ob.step4link'), href: '#/rules' },
    },
    {
      title: t('ob.step5'),
      desc: interfered
        ? t('ob.step5done')
        : t('ob.step5wait'),
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
    toast(t('ob.alldone'));
    renderOnboarding();
  }
}

/* ── 查询账本 ─────────────────────────────── */
const FILTER_CHIPS = ['all', 'forward', 'hijack', 'pollute', 'nxdomain', 'drop'];
const filterLabel = (k) => (k === 'all' ? t('filter.all') : k === 'nxdomain' ? t('filter.nxdomain') : t(`action.${k}`));

function renderFilterChips() {
  $('#ledger-filter').innerHTML = FILTER_CHIPS.map((k) =>
    `<button class="chip ${state.ledgerFilter === k ? 'on' : ''}" data-filter="${k}" style="--accent:${k === 'all' ? 'var(--brand)' : ACTION_META[k]?.color}">${esc(filterLabel(k))}</button>`).join('');
  $$('#ledger-filter .chip').forEach((c) => {
    c.onclick = () => {
      state.ledgerFilter = c.dataset.filter;
      $$('#ledger-filter .chip').forEach((x) => x.classList.toggle('on', x === c));
      renderLedger();
    };
  });
}

function initLedgerTools() {
  renderFilterChips();

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
    $('#ledger-pause').textContent = state.ledgerPaused ? t('ledger.resume') : t('ledger.pause');
  };
  $('#ledger-clear').onclick = async () => {
    try { await api('/api/reset', { method: 'POST' }); state.queries = []; renderLedger(); renderStats(); toast(t('ledger.cleared')); }
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
  let answer = q.ips.length ? q.ips.slice(0, 3).map(esc).join('<br>') : '<span class="t-dim">—</span>';
  if (q.suspicious) {
    answer += ` <span class="sus-mark" title="${esc(t('sus.mark', { ip: q.suspicious.ip, reason: t(`sus.reason.${q.suspicious.reason}`) }))}">⚠</span>`;
  }
  const clientName = displayClient(q.client);
  const clientActive = state.clientFilter === q.client;
  return `
    <tr class="${fresh ? 'fresh' : ''}">
      <td class="t-dim mono">${fmtTime(q.ts)}</td>
      <td><button class="client-cell mono ${clientActive ? 'on' : ''}" data-client="${esc(q.client)}" title="${clientName === q.client ? esc(t('ledger.clickOnly')) : `${esc(q.client)} · ${esc(t('ledger.clickOnly'))}`}" type="button">${esc(clientName)}</button></td>
      <td class="t-domain mono">${esc(q.domain)}</td>
      <td class="mono t-dim">${esc(q.type)}</td>
      <td><span class="badge" data-action="${q.action}"><i></i>${esc(actionLabel(q.action))}</span></td>
      <td class="mono">${answer}</td>
      <td class="t-dim mono">${q.latency}ms</td>
    </tr>`;
}

function renderLedger() {
  const rows = state.queries.filter(queryMatches).slice(0, 150);
  $('#ledger-body').innerHTML = rows.map((q) => ledgerRow(q)).join('');
  $('#ledger-empty').hidden = rows.length > 0;
  $$('.js-ip').forEach((el) => { el.textContent = state.status?.primaryIP || t('ledger.thisIp'); });
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
  chip.title = t('ledger.chipTitle', { ip: state.clientFilter });
}

function updateLedgerHint() {
  const total = state.queries.length;
  if (!total) { $('#ledger-hint').textContent = ''; return; }
  const filtered = state.ledgerFilter !== 'all' || state.ledgerSearch || state.clientFilter;
  const shown = state.queries.filter(queryMatches).length;
  const devPart = state.clientFilter ? `${displayClient(state.clientFilter)} · ` : '';
  $('#ledger-hint').textContent = filtered
    ? t('ledger.hintFiltered', { dev: devPart, shown, total })
    : t('ledger.hintTotal', { n: total });
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
  const zh = getLang() === 'zh';
  const demoReady = Boolean(s?.web?.demoPort && s?.primaryIP);
  $('#presets-row').innerHTML = state.presets.map((p) => {
    const applied = p.rules.filter((r) => state.rules.some((x) => x.domain === r.domain)).length;
    const total = p.rules.length;
    const full = applied === total;
    const canRemove = applied > 0;
    const name = zh ? p.name : (p.nameEn || p.name);
    const tag = zh ? (p.tag || p.name.split('：')[0]) : (p.tagEn || p.tag || name);
    const desc = zh ? p.description : (p.descriptionEn || p.description);
    const actionBtn = full
      ? `<button class="btn tiny ghost danger" data-preset-remove="${p.key}" type="button">${esc(t('preset.remove'))}</button>`
      : `<button class="btn tiny primary" data-preset-apply="${p.key}" type="button" ${p.key === 'hijack-demo' && !demoReady ? `disabled title="${esc(t('preset.needSudo'))}"` : ''}>${applied > 0 ? esc(t('preset.complete')) : esc(t('preset.apply'))}</button>`;
    return `
      <div class="preset ${p.key === 'hijack-demo' && !demoReady ? 'unavailable' : ''}">
        <h3>
          <span class="badge" data-action="${p.key === 'hijack-demo' ? 'hijack' : p.key === 'gfw' ? 'pollute' : 'nxdomain'}"><i></i>${esc(tag)}</span>
        </h3>
        <p>${esc(desc)}</p>
        <div class="foot">
          <span class="count">${canRemove ? esc(t('preset.applied', { a: applied, b: total })) : esc(t('preset.count', { n: total }))}</span>
          ${actionBtn}
        </div>
      </div>`;
  }).join('');

  $$('[data-preset-apply]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/presets/${b.dataset.presetApply}/apply`, { method: 'POST' });
        toast(t('preset.appliedToast', { a: r.added, skip: r.skipped ? t('preset.skipPart', { s: r.skipped }) : '' }));
      } catch (e) { toast(e.message, 'error'); }
      await refreshRules();
    };
  });
  $$('[data-preset-remove]').forEach((b) => {
    b.onclick = async () => {
      const preset = state.presets.find((p) => p.key === b.dataset.presetRemove);
      try {
        const r = await api('/api/rules/clear', { method: 'POST', body: { note: preset?.rules[0]?.note } });
        toast(t('preset.removedToast', { n: r.removed }));
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
  $('#rules-hint').textContent = rules.length ? t('rules.hint', { n: rules.length }) : '';
  $('#nav-rule-count').hidden = rules.length === 0;
  $('#nav-rule-count').textContent = rules.length;
  tbody.innerHTML = rules.map((r) => `
    <tr>
      <td class="t-domain mono">${esc(r.domain)}</td>
      <td><span class="badge" data-action="${r.action}"><i></i>${esc(actionLabel(r.action))}</span></td>
      <td class="mono">${r.action === 'hijack' ? esc(r.ip) : '<span class="t-dim">—</span>'}</td>
      <td class="t-dim">${r.note ? esc(r.note) : '—'}</td>
      <td>
        <label class="switch">
          <input type="checkbox" data-rule-toggle="${r.id}" ${r.enabled ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </td>
      <td>
        <button class="icon-btn" data-rule-del="${r.id}" title="${esc(t('rules.delTitle'))}" type="button">
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
        toast(t('rules.deleted'));
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
      toast(t('rules.added'));
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
    if (!confirm(t('rules.confirmClear'))) return;
    try {
      await api('/api/rules/clear', { method: 'POST' });
      toast(t('rules.cleared'));
      await refreshRules();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ── 设置页 ───────────────────────────────── */
const UPSTREAMS = [
  { ip: '119.29.29.29', nameKey: 'up.119' },
  { ip: '114.114.114.114', nameKey: 'up.114' },
  { ip: '223.5.5.5', nameKey: 'up.ali' },
  { ip: '8.8.8.8', name: 'Google DNS' },
  { ip: '1.1.1.1', name: 'Cloudflare' },
];

function renderSettings() {
  const cur = state.status?.dns?.upstream;
  $('#upstream-grid').innerHTML = UPSTREAMS.map((u) => `
    <button class="upstream-opt ${u.ip === cur ? 'on' : ''}" data-upstream="${u.ip}" type="button">
      <span class="ip">${u.ip}</span>
      <span class="name">${esc(u.nameKey ? t(u.nameKey) : u.name)}</span>
    </button>`).join('');
  $$('#upstream-grid .upstream-opt').forEach((b) => {
    b.onclick = async () => {
      try {
        const s = await api('/api/settings', { method: 'POST', body: { upstream: b.dataset.upstream } });
        state.status = s;
        renderTopbar(); renderSettings();
        toast(t('set.switched', { ip: b.dataset.upstream }));
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
        btn.textContent = t('set.confirm');
        setTimeout(() => { armed = false; btn.textContent = origin; }, 2600);
        return;
      }
      armed = false;
      try {
        if (btn.dataset.action === 'reset-stats') {
          await api('/api/reset', { method: 'POST' });
          state.queries = []; renderLedger(); renderStats(); toast(t('ledger.cleared'));
        } else if (btn.dataset.action === 'clear-cache') {
          await api('/api/cache/clear', { method: 'POST' });
          toast(t('set.cacheCleared'));
        } else if (btn.dataset.action === 'clear-rules') {
          await api('/api/rules/clear', { method: 'POST' });
          toast(t('rules.cleared'));
          await refreshRules();
        }
      } catch (e) { toast(e.message, 'error'); }
      btn.textContent = { 'reset-stats': t('set.clear'), 'clear-cache': t('set.clear'), 'clear-rules': t('set.delAll') }[btn.dataset.action];
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
      toast(t('set.switched', { ip }));
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ── SSE 实时事件 ─────────────────────────── */
function connectSSE() {
  const es = new EventSource('/api/events');
  const pill = $('#sse-pill');
  es.onopen = () => { pill.classList.remove('off'); pill.querySelector('span').textContent = t('side.live'); };
  es.onerror = () => { pill.classList.add('off'); pill.querySelector('span').textContent = t('side.liveOff'); };
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

/* ── 语言切换与全量重渲染 ───────────────────── */
function renderLangToggle() {
  const btn = $('#lang-toggle');
  if (!btn) return;
  btn.textContent = getLang() === 'en' ? '中文' : 'EN';
}

function renderLegend() {
  $('#wire-legend').innerHTML = ['forward', 'cache', 'hijack', 'pollute', 'nxdomain', 'drop']
    .map((k) => `<span><i style="background:${ACTION_META[k].color}"></i>${esc(actionLabel(k))}</span>`).join('');
}

/** 切换语言后重渲染所有动态区域 */
function rerenderAll() {
  renderLangToggle();
  renderLegend();
  renderTopbar(); renderBanners(); renderStats();
  renderFilterChips();
  $('#ledger-pause').textContent = state.ledgerPaused ? t('ledger.resume') : t('ledger.pause');
  renderLedger();
  renderRules(); renderPresets(); renderOnboarding();
  renderConnStatus();
  const pill = $('#sse-pill');
  if (pill) pill.querySelector('span').textContent = pill.classList.contains('off') ? t('side.liveOff') : t('side.live');
  handleRoute();
}

/* ── 初始化 ───────────────────────────── */
async function init() {
  $('#onboarding-toggle').onclick = () => {
    state.obDismissed = true;
    localStorage.setItem('dnslab.ob-dismissed', '1');
    $('#onboarding').hidden = true;
  };

  initLedgerTools();
  initRuleForm();
  initSettingsActions();

  renderLangToggle();
  $('#lang-toggle').onclick = () => setLang(getLang() === 'en' ? 'zh' : 'en');
  document.addEventListener('dnslab:lang', rerenderAll);

  renderLegend();

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
    `<div class="banner bad" style="margin:16px"><span>⛔</span><div>${t('init.fail', { msg: esc(err.message) })}</div></div>`);
});

// 暴露给 guide.js 使用
window.App = { state, api, toast, copyText, esc, isPhoneClient, ACTION_META, actionLabel, renderOnboarding };
