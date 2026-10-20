/**
 * 订阅身份保持的回归测试：机场上游地址会变，本地订阅 token/地址不能变。
 *   node test/identity.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CONFIG_FILE = mkdtempSync(path.join(tmpdir(), 'fch-ident-')) + '/config.json';
const { store, normalize } = await import('../src/store.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

const BASE = 'https://sub.example.com/sub';
const withParam = (target, token) =>
  `${BASE}?target=${target}&url=${encodeURIComponent(`https://a.example.com/osubscribe.php?token2=${token}`)}`;

/** 一个套餐 + 两条订阅（Clash / Surge） */
function seed(token = 'orig') {
  store.saveAccounts([{ name: '测试', baseUrl: 'https://api.example.com', email: 'a@b.c', password: 'pw123456' }]);
  const acc = store.data.accounts[0];
  store.saveDiscovered(acc.id, [
    {
      serviceId: '1001',
      name: 'Lite',
      subs: [
        { name: 'Clash', url: withParam('clash', token) },
        { name: 'Surge', url: withParam('surge', token) },
      ],
    },
  ]);
  return acc.id;
}

const snap = () =>
  store.listSubs().map((e) => ({ key: e.key, name: e.sub.name, token: e.sub.token, url: e.sub.url }));

const subsOf = (accountId, serviceId = '1001') => {
  const p = store.data.products.find((x) => x.accountId === accountId && x.serviceId === serviceId);
  return (p?.subs || []).map((s) => ({ key: `${p.id}-${s.id}`, name: s.name, token: s.token, url: s.url }));
};

/* ---------------- 1. url 完全不变 ---------------- */

{
  const accId = seed('t1');
  const before = snap();
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: withParam('clash', 't1') },
      { name: 'Surge', url: withParam('surge', 't1') },
    ] },
  ]);
  const after = snap();
  check('url 不变 → token 保持', after.every((s, i) => s.token === before[i].token));
  check('url 不变 → key 保持', after.every((s, i) => s.key === before[i].key));
}

/* ---------------- 2. 上游 token 被机场轮换（核心场景）---------------- */

{
  const accId = seed('t2');
  const before = snap();
  // 机场换了上游 token → url 全变，但订阅还是那两条
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: withParam('clash', 'ROTATED') },
      { name: 'Surge', url: withParam('surge', 'ROTATED') },
    ] },
  ]);
  const after = snap();
  check('上游轮换 → token 保持', after.every((s, i) => s.token === before[i].token),
    after.map((s, i) => `${s.name}:${s.token === before[i].token ? 'OK' : '变了'}`).join(' '));
  check('上游轮换 → key 保持', after.every((s, i) => s.key === before[i].key));
  check('上游轮换 → url 已更新', after[0].url.includes('ROTATED'));
  check('上游轮换 → token 未与 url 串味', after[0].token === before[0].token && after[0].url.includes('ROTATED'));
}

/* ---------------- 3. 仅参数顺序不同（等价 URL）---------------- */

{
  const accId = seed('t3');
  const before = snap();
  const swapped = (t) =>
    `${BASE}?url=${encodeURIComponent(`https://a.example.com/osubscribe.php?token2=${t}`)}&target=${t === 'x' ? 'clash' : 'surge'}`;
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: `${BASE}?url=${encodeURIComponent('https://a.example.com/osubscribe.php?token2=t3')}&target=clash` },
      { name: 'Surge', url: `${BASE}?url=${encodeURIComponent('https://a.example.com/osubscribe.php?token2=t3')}&target=surge` },
    ] },
  ]);
  const after = snap();
  check('参数顺序变化 → token 保持', after.every((s, i) => s.token === before[i].token));
  void swapped;
}

/* ---------------- 4. 机场改了订阅显示名 ---------------- */

{
  const accId = seed('t4');
  const before = snap();
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash 订阅', url: withParam('clash', 't4') },
      { name: 'Surge 订阅', url: withParam('surge', 't4') },
    ] },
  ]);
  const after = snap();
  // 名字变了但 url 相同 → 第 1 层 url 匹配生效
  check('改名但 url 相同 → token 保持', after.every((s, i) => s.token === before[i].token));
  check('改名但 url 相同 → 名称已更新', after[0].name === 'Clash 订阅', after[0].name);
}

/* ---------------- 5. 同名多条：靠 url 与位置区分，不能互相抢 ---------------- */

{
  store.saveAccounts([{ name: 'T2', baseUrl: 'https://api2.example.com', email: 'x@y.z', password: 'pw123456' }]);
  const acc = store.data.accounts.find((a) => a.email === 'x@y.z');
  store.saveDiscovered(acc.id, [
    { serviceId: '2002', name: 'Dup', subs: [
      { name: '通用订阅', url: withParam('ss', 'dup') },
      { name: '通用订阅', url: withParam('ssr', 'dup') },
      { name: '通用订阅', url: withParam('vmess', 'dup') },
    ] },
  ]);
  const before = snap();
  check('同名多条 → 各自拿到不同 token', new Set(before.map((s) => s.token)).size === 3);
  // 全部 url 变了、名字又都一样 → 只能靠位置兜底，但顺序不变时仍须一一对应
  store.saveDiscovered(acc.id, [
    { serviceId: '2002', name: 'Dup', subs: [
      { name: '通用订阅', url: withParam('ss', 'dup2') },
      { name: '通用订阅', url: withParam('ssr', 'dup2') },
      { name: '通用订阅', url: withParam('vmess', 'dup2') },
    ] },
  ]);
  const after = snap();
  check('同名多条 + 全换 url → 名称匹配不错位', after.every((s, i) => s.token === before[i].token),
    after.map((s, i) => `${s.url.match(/target=(\w+)/)?.[1]}:${s.token === before[i].token ? 'OK' : '错位'}`).join(' '));
}

/* ---------------- 6. 新增订阅：老的不动，新的才发新 token ---------------- */

{
  const accId = seed('t6');
  const before = snap();
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: withParam('clash', 'NEW') },
      { name: 'Surge', url: withParam('surge', 'NEW') },
      { name: 'Loon', url: withParam('loon', 'NEW') },
    ] },
  ]);
  const after = snap();
  check('新增第 3 条 → 前 2 条 token 不变',
    after[0].token === before[0].token && after[1].token === before[1].token);
  check('新增第 3 条 → 新条用新 token', after[2] && after[2].token !== before[0].token && after[2].token !== before[1].token);
}

/* ---------------- 7. 删订阅 + 新增 + 顺序变化：老订阅不能丢 token ---------------- */

{
  const accId = seed('t7');
  const before = snap();
  // 机场删掉 Surge、新增 Loon，且 Loon 排在最前。
  // 曾经写成「每条新订阅依次尝试 url → name → 位置」：Loon 的 url 配不上就
  // 落到位置层抢走 Clash 的旧记录，轮到 Clash 时已无记录可配 → Clash 丢 token。
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Loon', url: withParam('loon', 'brandnew') },
      { name: 'Clash', url: withParam('clash', 't7') },
    ] },
  ]);
  const after = snap();
  const tok = (list, n) => list.find((s) => s.name === n)?.token;
  check('顺序变化 + 删一条 → Clash token 保住',
    tok(after, 'Clash') === tok(before, 'Clash'),
    `${String(tok(before, 'Clash')).slice(0, 6)} → ${String(tok(after, 'Clash')).slice(0, 6)}`);
  check('新订阅 Loon 不抢任何现有活动订阅的 token',
    !before.some((s) => s.token === tok(after, 'Loon')),
    `Loon=${String(tok(after, 'Loon')).slice(0, 6)}`);
  check('被删的 Surge 不再出现', !after.some((s) => s.name === 'Surge'));
}

/* ---------------- 8. token 唯一性不能被破坏 ---------------- */

{
  const all = store.listSubs().map((e) => e.sub.token);
  check('全局 token 无重复', new Set(all).size === all.length, `${all.length} 条`);
}

/* ---------------- 9. 连续多次刷新，token 持续稳定 ---------------- */

{
  const accId = seed('t8');
  const before = snap();
  for (let round = 1; round <= 4; round++) {
    store.saveDiscovered(accId, [
      { serviceId: '1001', name: 'Lite', subs: [
        { name: 'Clash', url: withParam('clash', `r${round}`) },
        { name: 'Surge', url: withParam('surge', `r${round}`) },
      ] },
    ]);
  }
  const after = snap();
  check('连续 4 轮刷新 → token 始终不变', after.every((s, i) => s.token === before[i].token),
    `url 已变为 ${after[0].url.match(/token2=([^&)]*)/)?.[1]}`);
}

/* ---------------- 10. 换套餐（serviceId 不同）不算同一份 ---------------- */

{
  const accId = seed('t9');
  store.saveDiscovered(accId, [
    { serviceId: '2002', name: 'Pro', subs: [{ name: 'Clash', url: withParam('clash', 'pro') }] },
  ]);
  const all = store.listSubs();
  const old = all.find((e) => e.product.serviceId === '1001');
  const neu = all.find((e) => e.product.serviceId === '2002');
  // 抓不到的老套餐会被保留（可能只是临时下架），所以老 token 仍应留在列表里
  check('serviceId 变化 → 老套餐仍保留', !!old);
  check('serviceId 变化 → 老 token 未被改写', old && old.sub.url.includes('t9'));
  check('serviceId 变化 → 新套餐用新 token', neu && neu.sub.token !== old?.sub.token);
}

/* ---------------- 11. 详情页临时失败：不得清空旧订阅 ---------------- */

{
  const accId = seed('failure');
  const before = subsOf(accId);
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [], subsComplete: false },
  ]);
  const after = subsOf(accId);
  check('详情页失败 → 旧订阅不被清空', after.length === before.length, `${before.length} → ${after.length}`);
  check('详情页失败 → 所有 token 保持不变', after.every((s, i) => s.token === before[i].token));
}

/* ---------------- 12. 单条订阅短暂消失：恢复后沿用原 token ---------------- */

{
  const accId = seed('missing');
  const before = subsOf(accId);
  const oldSurge = before.find((s) => s.name === 'Surge');
  // 模拟本轮只解析到 Clash，Surge 被页面临时漏掉。
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: withParam('clash', 'missing-next') },
    ] },
  ]);
  const partial = subsOf(accId);
  check('单条暂时消失 → 活动列表只保留本轮订阅', partial.length === 1, String(partial.length));
  check('单条暂时消失 → 未消失的 token 保持', partial[0]?.token === before[0]?.token);
  const persisted = normalize(JSON.parse(JSON.stringify(store.data)));
  const persistedProduct = persisted.products.find(
    (p) => p.accountId === accId && p.serviceId === '1001'
  );
  const retiredSurge = (persistedProduct?.retiredSubs || []).find((s) => s.name === 'Surge');
  check('单条暂时消失 → 历史 token 可落盘并重新载入', retiredSurge?.token === oldSurge?.token);

  // Surge 下一轮回来，且上游地址也换了；历史记录仍应把原 token 还给它。
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Clash', url: withParam('clash', 'missing-next') },
      { name: 'Surge', url: withParam('surge', 'missing-returned') },
    ] },
  ]);
  const restored = subsOf(accId);
  const newSurge = restored.find((s) => s.name === 'Surge');
  check('单条订阅恢复 → 原 token 恢复', !!newSurge && newSurge.token === oldSurge?.token);
}

/* ---------------- 13. 名称和 url 都认不出：不得按位置猜身份 ---------------- */

{
  const accId = seed('position');
  const before = subsOf(accId);
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: '客户端 A', url: withParam('a', 'position-next') },
      { name: '客户端 B', url: withParam('b', 'position-next') },
    ] },
  ]);
  const after = subsOf(accId);
  check('身份完全无法识别 → 不复用旧 token', after.every((s) => !before.some((b) => b.token === s.token)));
}

/* ---------------- 14. 新增订阅 + 另一条地址轮换：新增项不能抢旧 token ---------------- */

{
  const accId = seed('mixed-add');
  const before = subsOf(accId);
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: 'Loon 专属新增', url: withParam('loon-new', 'mixed-add') },
      { name: 'Surge', url: withParam('surge', 'mixed-add-rotated') },
    ] },
  ]);
  const after = subsOf(accId);
  const newLoon = after.find((s) => s.name === 'Loon 专属新增');
  const oldSurge = before.find((s) => s.name === 'Surge');
  const newSurge = after.find((s) => s.name === 'Surge');
  check('新增项不抢现有活动 token', !!newLoon && !before.some((s) => s.token === newLoon.token));
  check('另一条地址轮换 → 原 token 保持', newSurge?.token === oldSurge?.token);
}

/* ---------------- 15. 改名 + 上游轮换：target 签名仍能认回原订阅 ---------------- */

{
  const accId = seed('signature');
  const before = subsOf(accId);
  store.saveDiscovered(accId, [
    { serviceId: '1001', name: 'Lite', subs: [
      { name: '客户端 B', url: withParam('surge', 'signature-next') },
      { name: '客户端 A', url: withParam('clash', 'signature-next') },
    ] },
  ]);
  const after = subsOf(accId);
  const targetOf = (s) => new URL(s.url).searchParams.get('target');
  const oldClash = before.find((s) => targetOf(s) === 'clash');
  const oldSurge = before.find((s) => targetOf(s) === 'surge');
  const newClash = after.find((s) => targetOf(s) === 'clash');
  const newSurge = after.find((s) => targetOf(s) === 'surge');
  check('改名+轮换 → Clash 签名匹配原 token', newClash?.token === oldClash?.token);
  check('改名+轮换 → Surge 签名匹配原 token', newSurge?.token === oldSurge?.token);
}

rmSync(process.env.CONFIG_FILE, { force: true });
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
process.exit(fail ? 1 : 0);
