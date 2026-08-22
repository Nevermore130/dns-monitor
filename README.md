# DNS Lab — 本地 DNS 劫持与污染实验台

**[中文](#中文)** | **[English](#english)**

一个跑在你电脑上的 DNS 服务器 + 可视化控制台：手机连上 Wi-Fi 把 DNS 指向它，就能在浏览器里实时看到每一次解析，并一键模拟 **DNS 劫持**、**DNS 污染**、**域名拦截** 等场景。零依赖（纯 Node.js，无需 `npm install`）。

---

# 中文

## 功能

- **真实 DNS 服务**：UDP 53 端口监听，手机「手动 DNS」直连；未命中规则的查询保真转发到上游（阿里 / 腾讯 / 114 / Google / Cloudflare 或自定义），带 TTL 缓存
- **五种干预动作**

  | 动作 | 效果 | 典型用途 |
  |---|---|---|
  | 劫持 | 返回指定 IP | 钓鱼 / 重定向演示 |
  | 模拟污染 | 返回经典污染池假 IP | GFW 式 DNS 污染演示 |
  | NXDOMAIN | 返回「域名不存在」 | 广告 / 追踪域名拦截 |
  | 丢弃 | 不响应 | 制造解析超时 |
  | 正常转发 | 白名单放行 | 对照实验 |

- **可视化控制台**：实时包流动画（手机 ⇄ DNS Lab ⇄ 上游）、六色「判决」账本、统计卡片、规则增删改、一键预设
- **三个内置预设**：劫持跳转演示（example.com → 本机拦截页）、GFW 风格污染模拟、广告域名拦截
- **多设备管理**：顶栏常驻手机连接状态（不再弹窗打扰）；设备面板支持给每台设备**起备注名**（持久化）、查看各自在线状态与统计、一键「只看此设备」筛选账本；账本客户端列可点击筛选，首查域名辅助识别陌生设备
- **操作引导**：五步新手检查单（自动检测手机接入）、iOS / Android 图文设置步骤、CSS 手机模型、背景知识与排障手册
- **上游劫持检测**：转发应答含保留/私有段 IP（如 Clash TUN fake-ip 的 198.18.x.x）时，控制台弹出告警并在账本逐行标记，避免手机拿到不可达地址
- **中英双语**：控制台默认英文，顶栏一键切换中文（记住选择）；拦截页按浏览器语言自动适配，API 校验消息跟随 Accept-Language；CLI 支持 `--lang zh`

## 快速开始

要求：Node.js ≥ 18（无需安装任何依赖）

```bash
# 标准启动（DNS:53 + 控制台:3000 + 80端口演示页，需要 sudo 绑定低端口）
sudo node server/index.js

# 或者用 npm
sudo npm start
```

看到启动横幅后，浏览器打开 `http://localhost:3000`：

1. 跟着仪表盘「开始使用」检查单 / 「连接引导」页操作：手机连同一 Wi-Fi → 手机 DNS 填横幅里的本机 IP
2. 在「劫持规则」页点一个预设（推荐先玩 **劫持跳转演示**）
3. 手机浏览器打开 `example.com` —— 你会看到本工具的红色「已被劫持」拦截页
4. 回到仪表盘看账本：每次查询的判决、应答 IP、耗时一目了然
5. 多台手机接入后：点顶栏「已连接 N 台手机」给设备改名，按需「只看此设备」

> 没有 sudo 也能跑：`node server/index.js --dns-port 5333`，此时 DNS 落在高位端口，手机无法直连，但可用 `dig @<本机IP> -p 5333 example.com` 在局域网内联调，控制台功能完整（横幅会提示你切换到 sudo 模式）。

### 命令行参数

```
sudo node server/index.js [选项]

  --dns-port <端口>    DNS 服务端口     默认 53
  --http-port <端口>   Web 控制台端口   默认 3000（被占用时自动 +1）
  --upstream <IP>      上游 DNS        默认 119.29.29.29
  --no-fallback        端口不可用时直接退出
  --lang <en|zh>       CLI / 启动横幅语言，默认 en
```

## 项目结构

```
├── server/
│   ├── index.js         # 入口：参数解析、端口回退、启动横幅
│   ├── dns-packet.js    # DNS 报文解析/构造（RFC 1035 子集，零依赖）
│   ├── dns-server.js    # UDP 服务：规则裁决 → 应答或上游转发（含缓存）
│   ├── rule-engine.js   # 规则匹配（精确/通配符）、持久化、预设
│   ├── device-store.js  # 设备备注名持久化
│   ├── ip-sentinel.js   # 可疑应答 IP 检测（保留/私有段，上游劫持告警）
│   ├── web-server.js    # REST API + SSE 推流 + 静态资源 + 80端口演示页
│   └── netinfo.js       # 局域网 IP 探测
├── public/              # 控制台前端（原生 HTML/CSS/JS，无框架无 CDN）
├── data/                # 运行时数据：rules.json（规则）、devices.json（设备名），自动创建
└── package.json
```

## 常见问题

**手机连不上 / 账本里没有手机的查询？**
按优先级检查：手机是否开了 VPN / iOS「专用代理」/ Android「私人 DNS」（会绕过本地 DNS）→ 路由器 AP 隔离是否关闭 → macOS 防火墙是否放行 node 入站 → 服务是否以 sudo 运行（手机只认 53 端口）。控制台「连接引导」页底部有完整排障手册。

**改了规则手机没反应？**
DNS 缓存。本工具下发的劫持记录 TTL 只有 30 秒，等一下或开关一次飞行模式即可。

**恢复原状？**
手机上把该 Wi-Fi 的 DNS 改回「自动」；电脑上 Ctrl+C 停服务。用 sudo 跑过后可用 `sudo chown -R $(whoami) data` 恢复数据文件属主。

---

# English

A DNS server + visual console that runs on your computer. Point your phone's DNS at it, watch every lookup live in the browser, and simulate **DNS hijacking**, **DNS poisoning**, and **domain blocking** with one click. Zero dependencies (pure Node.js, no `npm install` needed).

## Features

- **Real DNS service**: listens on UDP port 53 so phones can connect directly via "manual DNS"; unmatched queries are faithfully forwarded upstream (Alibaba / Tencent / 114 / Google / Cloudflare or custom), with TTL caching
- **Five intervention actions**

  | Action | Effect | Typical use |
  |---|---|---|
  | Hijack | Returns a chosen IP | Phishing / redirect demo |
  | Pollute | Returns fake IPs from the classic pollution pool | GFW-style DNS poisoning demo |
  | NXDOMAIN | Returns "domain does not exist" | Ad / tracker blocking |
  | Drop | No response at all | Simulating resolution timeout |
  | Forward | Whitelist passthrough | Control experiment |

- **Visual console**: live traffic animation (Phone ⇄ DNS Lab ⇄ Upstream), a six-color "verdict" ledger, stat cards, rule CRUD, one-click presets
- **Three built-in presets**: hijack-to-intercept-page demo (example.com → local block page), GFW-style pollution simulation, ad-domain blocking
- **Multi-device management**: persistent phone-connection status in the top bar (no more pop-ups); a device panel for **naming each device** (persisted), viewing per-device online status and stats, and one-click "show this device only" ledger filtering; the ledger's client column is clickable to filter, and each device's first query domain helps identify strangers
- **Onboarding guide**: a five-step checklist (auto-detects phone connection), illustrated iOS / Android setup steps, a CSS phone mockup, plus background knowledge and a troubleshooting handbook
- **Upstream hijack detection**: when forwarded answers contain reserved/private-range IPs (e.g. 198.18.x.x from Clash TUN fake-ip), the console raises a banner and marks each affected ledger row, so you know why phones can't reach those addresses
- **Bilingual (EN/ZH)**: the console defaults to English with a one-click switch to Chinese in the top bar (the choice is remembered); the intercept page follows the browser language, API validation messages follow Accept-Language, and the CLI accepts `--lang zh`

## Quick Start

Requires: Node.js ≥ 18 (no dependencies to install)

```bash
# Standard start (DNS :53 + console :3000 + port-80 demo page; sudo needed for low ports)
sudo node server/index.js

# or via npm
sudo npm start
```

Once the banner appears, open `http://localhost:3000` in a browser:

1. Follow the "Get started" checklist on the dashboard or the "Connection guide" page: phone joins the same Wi-Fi → set the phone's DNS to the LAN IP shown in the banner
2. On the "Hijack rules" page, apply a preset (try the **hijack demo** first)
3. Open `example.com` in the phone's browser — you'll see the red "hijacked" intercept page served by this tool
4. Back on the dashboard, watch the ledger: every query's verdict, response IPs, and latency at a glance
5. When multiple phones join: click "N devices connected" in the top bar to rename them and filter by device as needed

> Works without sudo too: `node server/index.js --dns-port 5333`. DNS then sits on a high port that phones can't reach directly, but you can test from the LAN with `dig @<your-ip> -p 5333 example.com`; the console works fully (the banner reminds you to switch to sudo mode).

### Command-line options

```
sudo node server/index.js [options]

  --dns-port <port>   DNS service port     default 53
  --http-port <port>  Web console port     default 3000 (auto +1 if busy)
  --upstream <IP>     Upstream DNS server  default 119.29.29.29
  --no-fallback       Exit instead of falling back when a port is unavailable
  --lang <en|zh>      CLI / startup-banner language, default en
```

## Project structure

```
├── server/
│   ├── index.js         # Entry: arg parsing, port fallback, startup banner
│   ├── dns-packet.js    # DNS packet parsing/building (RFC 1035 subset, zero deps)
│   ├── dns-server.js    # UDP service: rule verdict → respond or forward upstream (with cache)
│   ├── rule-engine.js   # Rule matching (exact/wildcard), persistence, presets
│   ├── device-store.js  # Device nickname persistence
│   ├── ip-sentinel.js   # Suspicious answer IP detection (reserved/private ranges, upstream-hijack alert)
│   ├── web-server.js    # REST API + SSE stream + static assets + port-80 demo page
│   └── netinfo.js       # LAN IP discovery
├── public/              # Console frontend (vanilla HTML/CSS/JS, no frameworks, no CDN)
├── data/                # Runtime data: rules.json (rules), devices.json (device names); auto-created
└── package.json
```

## FAQ

**Phone can't connect / no phone queries in the ledger?**
Check in order of likelihood: VPN / iOS "Limit IP Address Tracking" (Private Relay) / Android "Private DNS" on the phone bypasses local DNS → AP isolation on the router is on → macOS firewall blocks inbound node → the service isn't running with sudo (phones only talk to port 53). The "Connection guide" page has a full troubleshooting handbook.

**Rule changed but the phone doesn't react?**
DNS cache. Hijacked records served here have a 30-second TTL — wait a moment or toggle airplane mode.

**How to revert everything?**
Set the phone's DNS for that Wi-Fi back to "Automatic"; Ctrl+C to stop the service on the computer. If you ran with sudo, restore data-file ownership with `sudo chown -R $(whoami) data`.

---

**For local learning, teaching demos, and authorized testing only.** Do not use this tool to interfere with anyone else's network or any production environment.
