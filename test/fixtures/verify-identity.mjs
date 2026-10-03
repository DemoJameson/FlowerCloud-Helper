/**
 * 用真实配置验证：模拟机场轮换上游 token 后，本地订阅 token 是否保持不变。
 *   node test/fixtures/verify-identity.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config.dev.json');
if (!existsSync(src)) {
  console.log('test/config.dev.json 不存在（gitignored），跳过');
  process.exit(0);
}
const raw = JSON.parse(readFileSync(src, 'utf8'));

// 用副本，避免动到本地开发配置
const dir = mkdtempSync(path.join(tmpdir(), 'fch-real-'));
const file = path.join(dir, 'config.json');
writeFileSync(file, JSON.stringify(raw));
process.env.CONFIG_FILE = file;

const { store } = await import('../../src/store.js');

const before = store.listSubs().map((e) => ({ key: e.key, token: e.sub.token, name: e.sub.name, url: e.sub.url }));
console.log(`真实配置：${store.data.accounts.length} 账号 / ${store.data.products.length} 套餐 / ${before.length} 条订阅\n`);

// 模拟机场轮换：把每条订阅 url 里的上游 token2 / sip002 换掉
// 按 accountId 分组 —— 同账号下可能有相同 serviceId，不能把各账号的套餐混在一起
const byAccount = new Map(store.data.accounts.map((a) => [a.id, []]));
for (const p of store.data.products) {
  byAccount.get(p.accountId)?.push({
    serviceId: p.serviceId,
    name: p.name,
    expire: p.expire,
    subs: p.subs.map((s) => ({
      name: s.name,
      // 机场重抓后 url 会带上新的上游 token，且参数顺序可能变
      url: s.url
        .replace(/token2%3D[^&]+/g, 'token2%3DROTATED')
        .replace(/token2=[^&]+/g, 'token2=ROTATED')
        .replace(/sip002%3D1/g, 'sip002%3D2')
        .replace(/sip002=1/g, 'sip002=2')
        .replace(/(\?|&)target=/, '$1cachebust=1&target='),
    })),
  });
}

for (const [accId, mine] of byAccount) {
  store.saveDiscovered(accId, mine);
}

const after = store.listSubs().map((e) => ({ key: e.key, token: e.sub.token, name: e.sub.name, url: e.sub.url }));

// 按 key（= 套餐id-订阅id）配对，不能按数组下标：saveDiscovered 会把
// 本账号的套餐挪到数组尾部（[...rest, ...merged]），下标全变了会误判成「都变了」
const beforeByKey = new Map(before.map((s) => [s.key, s]));
const afterByKey = new Map(after.map((s) => [s.key, s]));

let changedToken = 0;

let urlUpdated = 0;
let missing = 0;
const details = [];
for (const [key, b] of beforeByKey) {
  const a = afterByKey.get(key);
  if (!a) {
    missing++;
    details.push(`  丢失: ${b.name} (${key})`);
    continue;
  }
  if (a.url !== b.url) urlUpdated++;
  if (a.token !== b.token) {
    changedToken++;
    details.push(`  token 变了: ${b.name} ${b.token} → ${a.token}`);
  }
}
for (const key of afterByKey.keys()) {
  if (!beforeByKey.has(key)) {
    missing++;
    details.push(`  新增: ${afterByKey.get(key).name} (${key})`);
  }
}


console.log(`订阅条数        ${before.length} → ${after.length}`);
console.log(`url 已更新      ${urlUpdated} 条（机场侧确实变了）`);
console.log(`本地 token 变化 ${changedToken} 条  ${changedToken === 0 ? '✓ 全部保持' : '✗'}`);
console.log(`订阅增/丢       ${missing} 条  ${missing === 0 ? '✓ 无增无丢' : '✗'}`);
details.slice(0, 10).forEach((d) => console.log(d));

rmSync(dir, { recursive: true, force: true });
process.exit(changedToken || missing ? 1 : 0);
