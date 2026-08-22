// 设备备注名持久化：{ "192.168.1.108": "我的 iPhone" }
// 帮助多设备场景下区分不同手机（IP 对人不友好）
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class DeviceStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = join(dataDir, 'devices.json');
    this.names = this.#load();
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      }
    } catch (err) {
      console.error(`[devices] 读取设备名失败: ${err.message}`);
    }
    return {};
  }

  #persist() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.names, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[devices] 保存设备名失败: ${err.message}`);
    }
  }

  get(ip) {
    return this.names[ip] || null;
  }

  all() {
    return { ...this.names };
  }

  /** 设置设备名（传空字符串 = 删除备注），IP 有效性校验 */
  set(ip, name, lang = 'en') {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip))) return { error: lang === 'zh' ? '非法的 IP 地址' : 'Invalid IP address' };
    const n = String(name || '').trim().slice(0, 30);
    if (!n) delete this.names[ip];
    else this.names[ip] = n;
    this.#persist();
    this.emit('change', this.all());
    return { ok: true };
  }
}
