// 劫持/污染规则引擎：匹配、校验、持久化与预设场景
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ACTIONS = {
  hijack: { label: '劫持到指定 IP', value: 'hijack' },
  pollute: { label: '模拟污染(随机假 IP)', value: 'pollute' },
  nxdomain: { label: '域名不存在(NXDOMAIN)', value: 'nxdomain' },
  drop: { label: '不响应(丢弃)', value: 'drop' },
  forward: { label: '正常转发(白名单)', value: 'forward' },
};

/** 校验/错误消息双语词典（默认英文） */
const MSGS = {
  en: {
    emptyDomain: 'Domain is required',
    domainTooLong: 'Domain is too long',
    badLabel: 'Invalid domain label: "{x}"',
    badAction: 'Unknown action type',
    hijackNeedsIP: 'The hijack action needs a valid IPv4 address (IPv4 only for now)',
    dupDomain: 'A rule for {x} already exists — edit or delete it first',
    noRule: 'Rule not found',
    badIP: 'Invalid IPv4 address',
    noPreset: 'Preset not found',
    noLanIP: 'No LAN IP detected on this machine — this preset cannot be applied',
  },
  zh: {
    emptyDomain: '域名不能为空',
    domainTooLong: '域名过长',
    badLabel: '域名段格式不正确: "{x}"',
    badAction: '无效的动作类型',
    hijackNeedsIP: '劫持动作需要填写合法的 IPv4 地址（当前仅支持 IPv4）',
    dupDomain: '已存在域名 {x} 的规则，请先编辑或删除',
    noRule: '规则不存在',
    badIP: '非法的 IPv4 地址',
    noPreset: '预设不存在',
    noLanIP: '未检测到本机局域网 IP，无法应用该预设',
  },
};

export function msg(lang, key, vars) {
  let s = (MSGS[lang] && MSGS[lang][key]) ?? MSGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** 内置预设场景（hijack-demo 的 IP 在应用时动态填充为本机局域网 IP） */
export const PRESETS = {
  'hijack-demo': {
    key: 'hijack-demo',
    name: '劫持演示：跳到本机拦截页',
    nameEn: 'Hijack demo: redirect to the local intercept page',
    tag: '劫持演示',
    tagEn: 'Hijack demo',
    description:
      '把 example.com 劫持到这台电脑。手机浏览器打开 example.com 会看到「已被劫持」演示页。' +
      '需要以 sudo 运行（占用 80 端口）。测完删除规则即可恢复。',
    descriptionEn:
      'Point example.com at this computer. Open example.com on the phone and you’ll see the “hijacked” demo page. ' +
      'Requires sudo (takes port 80). Delete the rule afterwards to revert.',
    requiresLanIP: true,
    rules: [
      { domain: 'example.com', action: 'hijack', note: '劫持演示预设' },
    ],
  },
  gfw: {
    key: 'gfw',
    name: '模拟 DNS 污染（GFW 风格）',
    nameEn: 'Simulated DNS pollution (GFW-style)',
    tag: '模拟污染',
    tagEn: 'Pollution',
    description:
      '对一批常用境外域名返回历史经典污染 IP（假地址），模拟真实环境的 DNS 污染现象。' +
      '测试完可一键删除，或逐条禁用。',
    descriptionEn:
      'Return classic polluted IPs (fake addresses) for a batch of popular domains, mimicking real-world DNS pollution. ' +
      'Remove them all with one click afterwards, or disable them one by one.',
    requiresLanIP: false,
    rules: [
      { domain: 'twitter.com', action: 'pollute', note: '污染模拟预设' },
      { domain: 'x.com', action: 'pollute', note: '污染模拟预设' },
      { domain: 'facebook.com', action: 'pollute', note: '污染模拟预设' },
      { domain: 'instagram.com', action: 'pollute', note: '污染模拟预设' },
      { domain: 'youtube.com', action: 'pollute', note: '污染模拟预设' },
      { domain: '*.google.com', action: 'pollute', note: '污染模拟预设' },
      { domain: 'wikipedia.org', action: 'pollute', note: '污染模拟预设' },
      { domain: 'bbc.co.uk', action: 'pollute', note: '污染模拟预设' },
    ],
  },
  block: {
    key: 'block',
    name: '广告 / 追踪域名拦截',
    nameEn: 'Ad / tracker domain blocking',
    tag: '广告拦截',
    tagEn: 'Ad blocking',
    description:
      '对常见广告与统计域名返回 NXDOMAIN（域名不存在），模拟广告拦截 DNS（如 AdGuard Home 的用法）。',
    descriptionEn:
      'Return NXDOMAIN (domain does not exist) for common ad and analytics domains, like an ad-blocking DNS (e.g. how AdGuard Home is used).',
    requiresLanIP: false,
    rules: [
      { domain: 'doubleclick.net', action: 'nxdomain', note: '广告拦截预设' },
      { domain: 'adservice.google.com', action: 'nxdomain', note: '广告拦截预设' },
      { domain: 'ad.atdmt.com', action: 'nxdomain', note: '广告拦截预设' },
      { domain: 'graph.facebook.com', action: 'nxdomain', note: '广告拦截预设' },
      { domain: 'app-measurement.com', action: 'nxdomain', note: '广告拦截预设' },
    ],
  },
};

/** 校验并规范化域名（支持 *.example.com 形式的后缀匹配） */
export function normalizeDomain(input, lang = 'en') {
  let d = String(input || '').trim().toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  const wildcard = d.startsWith('*.');
  const body = wildcard ? d.slice(2) : d;
  if (!body) return { error: msg(lang, 'emptyDomain') };
  if (body.length > 253) return { error: msg(lang, 'domainTooLong') };
  const labelRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  for (const label of body.split('.')) {
    if (!label || label.length > 63 || !labelRe.test(label)) {
      return { error: msg(lang, 'badLabel', { x: label }) };
    }
  }
  return { domain: wildcard ? `*.${body}` : body };
}

/** 简单 IPv4 校验 */
export function isValidIPv4(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

export class RuleEngine extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.file = join(dataDir, 'rules.json');
    this.rules = this.#load();
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(data)) return data;
      }
    } catch (err) {
      console.error(`[rules] 读取规则文件失败，使用空规则: ${err.message}`);
    }
    return [];
  }

  #persist() {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.rules, null, 2));
      renameSync(tmp, this.file); // 原子替换
    } catch (err) {
      console.error(`[rules] 保存规则失败: ${err.message}`);
    }
  }

  #changed() {
    this.#persist();
    this.emit('change', this.list());
  }

  list() {
    return [...this.rules];
  }

  /** 按顺序匹配域名，返回第一条命中的规则（大小写不敏感，*.example.com 覆盖子域） */
  match(domain) {
    const d = String(domain || '').toLowerCase().replace(/\.$/, '');
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const r = rule.domain;
      if (r.startsWith('*.')) {
        const base = r.slice(2);
        if (d === base || d.endsWith('.' + base)) return rule;
      } else if (d === r) {
        return rule;
      }
    }
    return null;
  }

  add({ domain, action, ip, note, lang = 'en' }) {
    const norm = normalizeDomain(domain, lang);
    if (norm.error) return { error: norm.error };
    if (!ACTIONS[action]) return { error: msg(lang, 'badAction') };
    if (action === 'hijack') {
      if (!isValidIPv4(ip)) return { error: msg(lang, 'hijackNeedsIP') };
    }
    const dup = this.rules.find((r) => r.domain === norm.domain);
    if (dup) return { error: msg(lang, 'dupDomain', { x: norm.domain }) };
    const rule = {
      id: randomUUID().slice(0, 8),
      domain: norm.domain,
      action,
      ip: action === 'hijack' ? ip : null,
      note: note ? String(note).slice(0, 100) : '',
      enabled: true,
      createdAt: Date.now(),
    };
    this.rules.unshift(rule);
    this.#changed();
    return { rule };
  }

  update(id, patch, lang = 'en') {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return { error: msg(lang, 'noRule') };
    if (patch.enabled !== undefined) rule.enabled = Boolean(patch.enabled);
    if (patch.action !== undefined && ACTIONS[patch.action]) rule.action = patch.action;
    if (patch.ip !== undefined) {
      if (rule.action === 'hijack' && !isValidIPv4(patch.ip)) return { error: msg(lang, 'badIP') };
      rule.ip = patch.ip || null;
    }
    if (patch.note !== undefined) rule.note = String(patch.note).slice(0, 100);
    this.#changed();
    return { rule };
  }

  remove(id, lang = 'en') {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return { error: msg(lang, 'noRule') };
    this.#changed();
    return { ok: true };
  }

  clear(noteFilter) {
    // noteFilter: 只删除指定 note 的规则（用于"删除整个预设"）
    const before = this.rules.length;
    this.rules = noteFilter
      ? this.rules.filter((r) => r.note !== noteFilter)
      : [];
    const removed = before - this.rules.length;
    if (removed > 0) this.#changed();
    return { removed };
  }

  /** 应用预设场景。hijack-demo 需传入本机局域网 IP */
  applyPreset(key, { lanIP, lang = 'en' } = {}) {
    const preset = PRESETS[key];
    if (!preset) return { error: msg(lang, 'noPreset') };
    if (preset.requiresLanIP && !lanIP) {
      return { error: msg(lang, 'noLanIP') };
    }
    let added = 0;
    let skipped = 0;
    for (const spec of preset.rules) {
      const exists = this.rules.some((r) => r.domain === spec.domain);
      if (exists) { skipped++; continue; }
      const res = this.add({
        ...spec,
        ip: spec.action === 'hijack' ? lanIP : undefined,
        lang,
      });
      if (res.error) { skipped++; continue; }
      added++;
    }
    return { added, skipped };
  }
}
