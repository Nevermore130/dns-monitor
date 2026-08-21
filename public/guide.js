/* DNS Lab — 连接引导页：图文步骤 / 实时检测 / 实验建议 / 知识与排障 */
'use strict';

(function () {
  const { state, esc, isPhoneClient } = window.App;

  /* ── 页面骨架 ───────────────────────────── */
  function render() {
    const root = document.getElementById('guide-root');
    if (!root) return;
    root.innerHTML = `
      <div class="guide-hero">
        <h2>把手机接进来，两分钟</h2>
        <p>DNS Lab 通过 Wi-Fi 接收手机的 DNS 查询。完成下面五步，之后手机上发生的每一次解析都会实时出现在仪表盘里。</p>
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
          <h3>确认手机与电脑连着同一个 Wi-Fi</h3>
          <p class="desc">
            手机的 DNS 请求要能「走到」这台电脑，前提是两台设备在同一个局域网里。
            如果路由器开了 <b>AP 隔离</b>（禁止无线设备互访），请暂时关闭它；
            没有路由器时，也可以用电脑开热点让手机连接。
          </p>
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
          <h3>拿到这台电脑的 IP 地址</h3>
          <p class="desc">下面这个地址就是稍后要填进手机的东西。</p>
          ${primary ? `
            <div class="ip-showcase">
              <span class="ip">${esc(primary)}</span>
              <span class="meta">检测到的首选局域网地址</span>
              <button class="btn primary" data-copy="${esc(primary)}" type="button">复制 IP</button>
            </div>
            ${others.length ? `
              <div class="iface-list">
                ${others.map((i) => `<span class="pill">${esc(i.iface)} <b>${esc(i.address)}</b></span>`).join('')}
              </div>
              <p class="desc" style="margin-top:10px">如果手机连的不是首选网卡所在的网络，就改用上面对应网段的地址。</p>` : ''}
          ` : `
            <div class="banner bad"><span>⛔</span><div>未检测到局域网 IPv4，请先连接 Wi-Fi 或插上网线，然后刷新页面。</div></div>`}
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
          <h3>在手机上把 DNS 改成手动</h3>
          <p class="desc">按你的手机系统选择步骤。改动只对当前 Wi-Fi 生效，删掉即可恢复原样。</p>
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
    const ip = esc(state.status?.primaryIP || '本机IP');
    return `
      <ol class="substeps">
        <li><span class="n">a</span><span>打开 <b>设置</b> → <b>无线局域网</b></span></li>
        <li><span class="n">b</span><span>点当前 Wi-Fi 名字右侧的 <b>( i )</b></span></li>
        <li><span class="n">c</span><span>拉到底部，进入 <b>配置 DNS</b></span></li>
        <li><span class="n">d</span><span>选 <b>手动</b>，删掉「DNS 服务器」里原有的条目</span></li>
        <li><span class="n">e</span><span>点 <b>添加服务器</b>，输入 <code>${ip}</code>，右上角 <b>存储</b></span></li>
        <li><span class="n">!</span><span>如果你开了 <b>iCloud 专用代理</b>（Private Relay），它会绕过本地 DNS——请到 设置 → 你的名字 → iCloud → 专用代理 里暂时关闭。<span class="warn-text">开着专用代理时，本工具看不到手机的查询。</span></span></li>
      </ol>`;
  }

  function androidSteps() {
    const ip = esc(state.status?.primaryIP || '本机IP');
    return `
      <ol class="substeps">
        <li><span class="n">a</span><span>打开 <b>设置</b> → <b>WLAN / Wi-Fi</b></span></li>
        <li><span class="n">b</span><span><b>长按</b>当前已连接的网络 → <b>修改网络</b></span></li>
        <li><span class="n">c</span><span>勾选「显示高级选项」，IP 设置改为 <b>静态</b></span></li>
        <li><span class="n">d</span><span><b>DNS 1</b> 填 <code>${ip}</code>（DNS 2 可留空），保存</span></li>
        <li><span class="n">!</span><span>如果手机开了 <b>私人 DNS</b>（Private DNS / DoT），它优先级高于手动 DNS——请到 设置 → 网络 → 私人 DNS 改为「关闭」。<span class="warn-text">开着私人 DNS 时，本工具看不到手机的查询。</span></span></li>
      </ol>`;
  }

  function iosMock() {
    const ip = esc(state.status?.primaryIP || '192.168.x.x');
    return `
      <div class="phone-mock" aria-hidden="true">
        <div class="notch"></div>
        <div class="mock-screen">
          <div class="mock-statusbar"><span>10:24</span><span>▲▂▄▆ &nbsp;▮</span></div>
          <div class="mock-title">配置 DNS</div>
          <div class="mock-row"><b>自动</b><span class="chev">○</span></div>
          <div class="mock-row hl"><b>手动</b><span class="chev">●</span></div>
          <div class="mock-row"><span>DNS 服务器</span></div>
          <div class="mock-row hl"><b>${ip}</b><span class="chev">－</span></div>
          <div class="mock-row"><span>添加服务器</span><span class="chev">＋</span></div>
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
          <div class="mock-title">修改网络</div>
          <div class="mock-row"><span>IP 设置</span><b>静态</b></div>
          <div class="mock-row"><span>IP 地址</span><span class="val">192.168.1.50</span></div>
          <div class="mock-row hl"><span>DNS 1</span><span class="val">${ip}</span></div>
          <div class="mock-row"><span>DNS 2</span><span class="val">—</span></div>
          <div class="mock-row"><span>私人 DNS</span><b>关闭</b></div>
        </div>
      </div>`;
  }

  /* ── 步骤 4 · 验证连接（实时） ──────────── */
  function stepVerify() {
    return `
      <div class="gstep" id="gstep-verify">
        <div class="gstep-rail"><div class="gstep-num" id="verify-num">4</div><div class="gstep-line"></div></div>
        <div class="gstep-body">
          <h3>验证：手机能找到这里吗？<span id="verify-tag" class="done-tag" hidden>已连接</span></h3>
          <p class="desc">设置保存后，用手机浏览器随便打开一个网页（比如 baidu.com），这一格就会自动亮起。</p>
          <div class="wait-box" id="verify-box">
            <div class="radar"></div>
            <div id="verify-text">等待来自手机的查询……<div class="detail" id="verify-detail" hidden></div></div>
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
        `连接成功 — 已收到来自 ${phoneQuery.client} 的查询。`;
      const detail = document.getElementById('verify-detail');
      detail.hidden = false;
      detail.textContent = `示例：${phoneQuery.domain}（${new Date(phoneQuery.ts).toLocaleTimeString('zh-CN', { hour12: false })}）`;
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
          <h3>开始实验</h3>
          <p class="desc">三个由浅入深的小实验，每个都只需要一条预设或一条规则。</p>
          <div class="labs-row">
            <div class="lab-card">
              <h4><span class="badge" data-action="hijack"><i></i>劫持</span>眼见为实的跳转</h4>
              <p>在「劫持规则」页应用<b>劫持演示</b>预设，然后用手机打开 example.com——你会看到本工具的拦截页，而不是真实网站。</p>
              <a class="btn tiny" href="#/rules">去应用预设</a>
            </div>
            <div class="lab-card">
              <h4><span class="badge" data-action="pollute"><i></i>污染</span>假 IP 是什么样</h4>
              <p>应用<b>模拟 DNS 污染</b>预设，手机访问预设里的域名：网页打不开，账本里却出现了「看起来正常」的假 IP。</p>
              <a class="btn tiny" href="#/rules">去应用预设</a>
            </div>
            <div class="lab-card">
              <h4><span class="badge" data-action="nxdomain"><i></i>拦截</span>让域名「消失」</h4>
              <p>应用<b>广告拦截</b>预设，或把任意域名动作设为 NXDOMAIN——手机会认为这个域名根本不存在。</p>
              <a class="btn tiny" href="#/rules">去添加规则</a>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ── 知识卡片 ───────────────────────────── */
  function knowledge() {
    return `
      <div class="knowledge">
        <div class="eyebrow" style="margin-bottom:10px">BACKGROUND · 背景知识</div>
        <details>
          <summary>DNS 劫持和 DNS 污染有什么区别？</summary>
          <div class="body">
            <b>DNS 劫持</b>（本工具的<span class="k-hijack">琥珀色判决</span>）：把域名解析到<b>攻击者指定的 IP</b>。
            真实世界里用于钓鱼——你以为在逛银行官网，其实到了假站点。本工具的「劫持演示」把它指向你自己电脑上的拦截页。<br>
            <b>DNS 污染</b>（<span class="k-pollute">玫红色判决</span>）：返回<b>随机、无效的假 IP</b>，目的不是骗你去某处，而是让你根本连不上真实服务。
            历史上 GFW 的污染应答就大量复用一批固定假 IP，本工具的污染池正是取自这批地址。
          </div>
        </details>
        <details>
          <summary>改了规则，手机怎么没反应？——DNS 缓存在捣乱</summary>
          <div class="body">
            手机和系统都会把解析结果缓存一段时间（本工具下发的劫持记录 TTL 只有 <code>30</code> 秒）。
            规则变化后最多等 30 秒；着急的话，开关一次<b>飞行模式</b>可以立刻清掉手机的 DNS 缓存。
          </div>
        </details>
        <details>
          <summary>为什么被污染的网站显示「打不开」而不是别的？</summary>
          <div class="body">
            污染返回的假 IP 上并没有真正提供服务，你的手机向它发起 TCP 连接会失败或超时——
            这正是污染「让正常访问失败」的原理。对照仪表盘账本里的假 IP，就能解释手机上看到的一切。
          </div>
        </details>
      </div>`;
  }

  /* ── 疑难解答 ───────────────────────────── */
  function troubleshooting() {
    return `
      <div class="knowledge">
        <div class="eyebrow" style="margin-bottom:10px">TROUBLESHOOTING · 疑难解答</div>
        <details>
          <summary>账本里一直看不到手机的查询</summary>
          <div class="body">
            ① 确认手机没有开 <b>VPN</b> / iOS「专用代理」/ Android「私人 DNS」——它们会绕过本地 DNS；<br>
            ② 路由器可能开启了 <b>AP 隔离</b>（禁止无线设备互访），需要关闭；<br>
            ③ macOS 应用防火墙可能拦截了 node 的入站连接：系统设置 → 网络 → 防火墙 → 放行 node；<br>
            ④ 确认服务以 <code>sudo</code> 运行（DNS 监听 53 端口），且手机填的 IP 与本机在同一网段。
          </div>
        </details>
        <details>
          <summary>dig 测试正常，手机却不行</summary>
          <div class="body">
            手机「手动 DNS」只会连 53 端口。看顶栏 DNS 端口 pill：如果不是 53，说明没加 sudo——
            复制横幅里的命令重启服务即可。用 dig 验证：<code>dig @本机IP baidu.com</code>。
          </div>
        </details>
        <details>
          <summary>怎么让手机恢复原状？</summary>
          <div class="body">
            手机上把该 Wi-Fi 的 DNS 改回<b>自动</b>即可，本工具不需要做任何事。
            如果想彻底退出实验：Ctrl+C 停掉服务，手机 DNS 会因为服务器失联而自动回落到移动网络 / 其他配置。
          </div>
        </details>
        <details>
          <summary>用 sudo 运行后，data/rules.json 变成 root 所有怎么办</summary>
          <div class="body">
            sudo 写入的文件属主是 root。恢复正常属主：<code>sudo chown -R $(whoami) data</code>。
            或者以后都用 sudo 运行，就不受影响。
          </div>
        </details>
      </div>`;
  }

  /* ── 事件绑定 ───────────────────────────── */
  function bindEvents(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => window.App.copyText(b.dataset.copy, `已复制 ${b.dataset.copy}`);
    });
    root.querySelectorAll('[data-platform]').forEach((t) => {
      t.onclick = () => {
        platform = t.dataset.platform;
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
