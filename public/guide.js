/* DNS Lab — 连接引导页：图文步骤 / 实时检测 / 实验建议 / 知识与排障 */
'use strict';

(function () {
  const { state, esc, isPhoneClient } = window.App;
  const { t, getLang } = window.I18n;

  /* ── 页面骨架 ───────────────────────────── */
  function render() {
    const root = document.getElementById('guide-root');
    if (!root) return;
    root.innerHTML = `
      <div class="guide-hero">
        <h2>${t('guide.heroT')}</h2>
        <p>${t('guide.heroP')}</p>
      </div>
      <div class="guide-steps">
        ${stepNetwork()}
        ${stepIP()}
        ${stepPhone()}
        ${stepVerify()}
        ${stepLabs()}
      </div>
      ${knowledge()}
      ${troubleshooting()}
    `;
    bindEvents(root);
    renderVerify();
  }

  /* ── 步骤 1 · 同一网络 ──────────────────── */
  function stepNetwork() {
    return `
      <div class="gstep">
        <div class="gstep-rail"><div class="gstep-num">1</div><div class="gstep-line"></div></div>
        <div class="gstep-body">
          <h3>${t('guide.s1t')}</h3>
          <p class="desc">${t('guide.s1p')}</p>
        </div>
      </div>`;
  }

  /* ── 步骤 2 · 本机 IP ───────────────────── */
  function stepIP() {
    const s = state.status;
    const primary = s?.primaryIP;
    const others = (s?.ips || []).filter((i) => i.address !== primary);
    return `
      <div class="gstep">
        <div class="gstep-rail"><div class="gstep-num">2</div><div class="gstep-line"></div></div>
        <div class="gstep-body">
          <h3>${t('guide.s2t')}</h3>
          <p class="desc">${t('guide.s2p')}</p>
          ${primary ? `
            <div class="ip-showcase">
              <span class="ip">${esc(primary)}</span>
              <span class="meta">${t('guide.s2meta')}</span>
              <button class="btn primary" data-copy="${esc(primary)}" type="button">${t('guide.s2copy')}</button>
            </div>
            ${others.length ? `
              <div class="iface-list">
                ${others.map((i) => `<span class="pill">${esc(i.iface)} <b>${esc(i.address)}</b></span>`).join('')}
              </div>
              <p class="desc" style="margin-top:10px">${t('guide.s2others')}</p>` : ''}
          ` : `
            <div class="banner bad"><span>⛔</span><div>${t('guide.s2nolan')}</div></div>`}
        </div>
      </div>`;
  }

  /* ── 步骤 3 · 手机设置（iOS / Android） ─── */
  let platform = localStorage.getItem('dnslab.platform') || 'ios';

  function stepPhone() {
    return `
      <div class="gstep">
        <div class="gstep-rail"><div class="gstep-num">3</div><div class="gstep-line"></div></div>
        <div class="gstep-body">
          <h3>${t('guide.s3t')}</h3>
          <p class="desc">${t('guide.s3p')}</p>
          <div class="tabs">
            <button class="tab ${platform === 'ios' ? 'on' : ''}" data-platform="ios" type="button">iPhone / iPad</button>
            <button class="tab ${platform === 'android' ? 'on' : ''}" data-platform="android" type="button">Android</button>
          </div>
          <div class="phone-panel">
            <div class="phone-steps">${platform === 'ios' ? iosSteps() : androidSteps()}</div>
            ${platform === 'ios' ? iosMock() : androidMock()}
          </div>
        </div>
      </div>`;
  }

  function iosSteps() {
    const ip = esc(state.status?.primaryIP || t('ledger.thisIp'));
    return `
      <ol class="substeps">
        <li><span class="n">a</span><span>${t('guide.ios.a')}</span></li>
        <li><span class="n">b</span><span>${t('guide.ios.b')}</span></li>
        <li><span class="n">c</span><span>${t('guide.ios.c')}</span></li>
        <li><span class="n">d</span><span>${t('guide.ios.d')}</span></li>
        <li><span class="n">e</span><span>${t('guide.ios.e', { ip })}</span></li>
        <li><span class="n">!</span><span>${t('guide.ios.warn')}</span></li>
      </ol>`;
  }

  function androidSteps() {
    const ip = esc(state.status?.primaryIP || t('ledger.thisIp'));
    return `
      <ol class="substeps">
        <li><span class="n">a</span><span>${t('guide.and.a')}</span></li>
        <li><span class="n">b</span><span>${t('guide.and.b')}</span></li>
        <li><span class="n">c</span><span>${t('guide.and.c')}</span></li>
        <li><span class="n">d</span><span>${t('guide.and.d', { ip })}</span></li>
        <li><span class="n">!</span><span>${t('guide.and.warn')}</span></li>
      </ol>`;
  }

  function iosMock() {
    const ip = esc(state.status?.primaryIP || '192.168.x.x');
    return `
      <div class="phone-mock" aria-hidden="true">
        <div class="notch"></div>
        <div class="mock-screen">
          <div class="mock-statusbar"><span>10:24</span><span>▲▂▄▆ &nbsp;▮</span></div>
          <div class="mock-title">${t('guide.mock.iosTitle')}</div>
          <div class="mock-row"><b>${t('guide.mock.auto')}</b><span class="chev">○</span></div>
          <div class="mock-row hl"><b>${t('guide.mock.manual')}</b><span class="chev">●</span></div>
          <div class="mock-row"><span>${t('guide.mock.servers')}</span></div>
          <div class="mock-row hl"><b>${ip}</b><span class="chev">－</span></div>
          <div class="mock-row"><span>${t('guide.mock.add')}</span><span class="chev">＋</span></div>
        </div>
      </div>`;
  }

  function androidMock() {
    const ip = esc(state.status?.primaryIP || '192.168.x.x');
    return `
      <div class="phone-mock" aria-hidden="true">
        <div class="notch"></div>
        <div class="mock-screen">
          <div class="mock-statusbar"><span>10:24</span><span>▲▂▄▆ &nbsp;▮</span></div>
          <div class="mock-title">${t('guide.mock.andTitle')}</div>
          <div class="mock-row"><span>${t('guide.mock.ipset')}</span><b>${t('guide.mock.static')}</b></div>
          <div class="mock-row"><span>${t('guide.mock.ip')}</span><span class="val">192.168.1.50</span></div>
          <div class="mock-row hl"><span>DNS 1</span><span class="val">${ip}</span></div>
          <div class="mock-row"><span>DNS 2</span><span class="val">—</span></div>
          <div class="mock-row"><span>${t('guide.mock.pdns')}</span><b>${t('guide.mock.off')}</b></div>
        </div>
      </div>`;
  }

  /* ── 步骤 4 · 验证连接（实时） ──────────── */
  function stepVerify() {
    return `
      <div class="gstep" id="gstep-verify">
        <div class="gstep-rail"><div class="gstep-num" id="verify-num">4</div><div class="gstep-line"></div></div>
        <div class="gstep-body">
          <h3>${t('guide.s4t')}<span id="verify-tag" class="done-tag" hidden>${t('guide.s4tag')}</span></h3>
          <p class="desc">${t('guide.s4p')}</p>
          <div class="wait-box" id="verify-box">
            <div class="radar"></div>
            <div id="verify-text">${t('guide.s4wait')}<div class="detail" id="verify-detail" hidden></div></div>
          </div>
        </div>
      </div>`;
  }

  function renderVerify() {
    const phoneQuery = state.queries.find((q) => isPhoneClient(q.client));
    const box = document.getElementById('verify-box');
    if (!box) return;
    if (phoneQuery) {
      box.classList.add('ok');
      document.getElementById('verify-text').firstChild.textContent =
        t('guide.s4ok', { ip: phoneQuery.client });
      const detail = document.getElementById('verify-detail');
      const locale = getLang() === 'zh' ? 'zh-CN' : 'en-GB';
      detail.hidden = false;
      detail.textContent = t('guide.s4eg', {
        d: phoneQuery.domain,
        t: new Date(phoneQuery.ts).toLocaleTimeString(locale, { hour12: false }),
      });
      document.getElementById('verify-tag').hidden = false;
      const gstep = document.getElementById('gstep-verify');
      gstep.classList.add('done');
    }
  }

  /* ── 步骤 5 · 实验建议 ──────────────────── */
  function stepLabs() {
    return `
      <div class="gstep">
        <div class="gstep-rail"><div class="gstep-num">5</div></div>
        <div class="gstep-body">
          <h3>${t('guide.s5t')}</h3>
          <p class="desc">${t('guide.s5p')}</p>
          <div class="labs-row">
            <div class="lab-card">
              <h4><span class="badge" data-action="hijack"><i></i>${t('action.hijack')}</span>${t('guide.lab1t')}</h4>
              <p>${t('guide.lab1p')}</p>
              <a class="btn tiny" href="#/rules">${t('guide.goApply')}</a>
            </div>
            <div class="lab-card">
              <h4><span class="badge" data-action="pollute"><i></i>${t('action.pollute')}</span>${t('guide.lab2t')}</h4>
              <p>${t('guide.lab2p')}</p>
              <a class="btn tiny" href="#/rules">${t('guide.goApply')}</a>
            </div>
            <div class="lab-card">
              <h4><span class="badge" data-action="nxdomain"><i></i>${t('filter.nxdomain')}</span>${t('guide.lab3t')}</h4>
              <p>${t('guide.lab3p')}</p>
              <a class="btn tiny" href="#/rules">${t('guide.goRules')}</a>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ── 知识卡片 ───────────────────────────── */
  function knowledge() {
    return `
      <div class="knowledge">
        <div class="eyebrow" style="margin-bottom:10px">${t('guide.kEyebrow')}</div>
        <details>
          <summary>${t('guide.k1q')}</summary>
          <div class="body">${t('guide.k1a')}</div>
        </details>
        <details>
          <summary>${t('guide.k2q')}</summary>
          <div class="body">${t('guide.k2a')}</div>
        </details>
        <details>
          <summary>${t('guide.k3q')}</summary>
          <div class="body">${t('guide.k3a')}</div>
        </details>
      </div>`;
  }

  /* ── 疑难解答 ───────────────────────────── */
  function troubleshooting() {
    return `
      <div class="knowledge">
        <div class="eyebrow" style="margin-bottom:10px">${t('guide.tEyebrow')}</div>
        <details>
          <summary>${t('guide.t1q')}</summary>
          <div class="body">${t('guide.t1a')}</div>
        </details>
        <details>
          <summary>${t('guide.t2q')}</summary>
          <div class="body">${t('guide.t2a')}</div>
        </details>
        <details>
          <summary>${t('guide.t3q')}</summary>
          <div class="body">${t('guide.t3a')}</div>
        </details>
        <details>
          <summary>${t('guide.t4q')}</summary>
          <div class="body">${t('guide.t4a')}</div>
        </details>
      </div>`;
  }

  /* ── 事件绑定 ───────────────────────────── */
  function bindEvents(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => window.App.copyText(b.dataset.copy, t('topbar.copiedIp', { ip: b.dataset.copy }));
    });
    root.querySelectorAll('[data-platform]').forEach((tab) => {
      tab.onclick = () => {
        platform = tab.dataset.platform;
        localStorage.setItem('dnslab.platform', platform);
        render();
      };
    });
  }

  /* ── 暴露：新查询到达时刷新步骤 4（连接状态由顶栏 pill 常驻显示，不再弹窗） ─── */
  function onQuery(entry) {
    if (document.getElementById('verify-box') && isPhoneClient(entry.client)) {
      renderVerify();
    }
  }

  window.Guide = { render, onQuery };
})();
