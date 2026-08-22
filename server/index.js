// DNS Lab 入口：解析参数 → 启动 DNS 服务 + Web 控制台
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLANIPv4s } from './netinfo.js';
import { DnsServer } from './dns-server.js';
import { WebServer } from './web-server.js';
import { RuleEngine } from './rule-engine.js';
import { DeviceStore } from './device-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '../data');

const HELP = `
DNS Lab — 本地 DNS 服务器与劫持/污染模拟实验台

用法:
  sudo node server/index.js [选项]

选项:
  --dns-port <端口>    DNS 服务端口        (默认 53，需要 sudo)
  --http-port <端口>   Web 控制台端口      (默认 3000)
  --upstream <IP>      上游 DNS 服务器     (默认 119.29.29.29)
  --no-fallback        端口不可用时直接退出，不回退
  -h, --help           显示帮助

示例:
  sudo node server/index.js                     # 标准启动（DNS:53 / 控制台:3000）
  node server/index.js --dns-port 5353          # 无 sudo 调试模式（dig -p 5353 测试）
  sudo node server/index.js --upstream 8.8.8.8  # 指定上游
`;

function parseArgs(argv) {
  const opts = { dnsPort: 53, httpPort: 3000, upstream: '119.29.29.29', fallback: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dns-port': opts.dnsPort = Number(argv[++i]); break;
      case '--http-port': opts.httpPort = Number(argv[++i]); break;
      case '--upstream': opts.upstream = argv[++i]; break;
      case '--no-fallback': opts.fallback = false; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default:
        console.error(`未知参数: ${a}\n使用 --help 查看用法`);
        process.exit(1);
    }
  }
  return opts;
}

function printBanner(dnsInfo, webInfo, upstream) {
  const ips = getLANIPv4s();
  const line = '─'.repeat(56);
  const rows = [
    ['控制台', `http://localhost:${webInfo.port}`],
    ...ips.slice(0, 2).map((ip) => ['', `http://${ip.address}:${webInfo.port}`]),
    ['DNS 服务', `udp://0.0.0.0:${dnsInfo.port}${dnsInfo.privilegedWarning ? '  (已回退)' : ''}`],
    ['上游 DNS', String(upstream)],
  ];
  if (webInfo.demoPort) rows.push(['劫持演示页', `http://<本机IP>/  (80 端口拦截页)`]);
  console.log(`\n${line}\n  DNS Lab 已启动\n${line}`);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10, '\u3000')}${v}`);
  console.log(`${line}\n  手机连接：Wi-Fi 详情 → 配置 DNS → 手动 → 填入上方局域网 IP\n`);

  if (dnsInfo.privilegedWarning) {
    console.log(`
⚠️  端口 ${dnsInfo.wanted} 无权限绑定，已回退到 ${dnsInfo.port}。
    手机的「手动 DNS」只支持 53 端口，请以管理员身份重新运行：

      sudo node server/index.js

    （回退端口可用于调试： dig @<本机IP> -p ${dnsInfo.port} example.com ）
`);
  }
  if (!webInfo.demoPort) {
    console.log('ℹ️  80 端口未监听（无 root 权限）。劫持跳转演示页不可用，其余功能正常。');
  }
  if (ips.length === 0) {
    console.log('⚠️  未检测到局域网 IPv4 地址，请检查网络连接（手机将无法配置本机 DNS）。');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rules = new RuleEngine(DATA_DIR);
  const devices = new DeviceStore(DATA_DIR);
  const dns = new DnsServer({
    rules,
    upstream: opts.upstream,
    wantedPort: opts.dnsPort,
    fallbackPorts: opts.fallback ? [5333, 5354, 5355] : [],
  });
  const web = new WebServer({
    dnsServer: dns,
    rules,
    devices,
    wantedPort: opts.httpPort,
    wantedDemoPort: 80,
  });

  const dnsInfo = await dns.start();
  const webInfo = await web.start();
  printBanner(dnsInfo, webInfo, opts.upstream);

  const shutdown = () => {
    console.log('\n正在停止 DNS Lab …');
    dns.stop();
    web.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`启动失败: ${err.message}`);
  if (err.code === 'EACCES') {
    console.error('提示: 绑定 53/80 端口需要管理员权限，请使用  sudo node server/index.js');
  }
  process.exit(1);
});
