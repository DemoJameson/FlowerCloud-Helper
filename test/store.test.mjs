/**
 * store（配置存储）的回归测试。
 *   npm run test:store
 *
 * 重点钉住：重复抓取不得产生重复套餐（曾因 rest 过滤条件写反，
 * 每点一次「刷新全部」套餐就翻倍）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store 是读取 env 后实例化的单例，必须先指到临时文件再 import
const tmpFile = path.join(os.tmpdir(), `fc-store-test-${process.pid}.json`);
fs.rmSync(tmpFile, { force: true });
process.env.CONFIG_FILE = tmpFile;

const { store, normalize, validateAdminPassword } = await import('../src/store.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

const PRODUCTS = [
  {
    serviceId: '409808',
    name: 'Global Acceleration Lite',
    expire: '2027-10-01',
    subs: [{ name: 'Clash', url: 'https://sub.example/clash?token2=A' }],
  },
  {
    serviceId: '409809',
    name: 'Global Acceleration Pro',
    expire: '2028-01-15',
    subs: [{ name: 'Clash', url: 'https://sub.example/pro?token2=B' }],
  },
];

/* ---- 账号 ---- */
const accounts = store.saveAccounts([
  { name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: 'pw1' },
  { name: '花云小号', baseUrl: 'https://api-flowercloud.com', email: 'b@x.com', password: 'pw2' },
]);
check('保存 2 个账号', accounts.length === 2);
const accA = store.data.accounts.find((a) => a.email === 'a@x.com');
const accB = store.data.accounts.find((a) => a.email === 'b@x.com');
check('账号 id 已生成', !!accA?.id && !!accB?.id);

/* ---- 首次抓取 ---- */
store.saveDiscovered(accA.id, PRODUCTS.map((p) => ({ ...p, subs: p.subs.map((s) => ({ ...s })) })));
check('首次抓取：2 个套餐', store.data.products.length === 2, String(store.data.products.length));

const idFirst = store.data.products[0].id;
const tokenFirst = store.data.products[0].subs[0].token;

/* ---- 重复抓取（核心回归：不得翻倍） ---- */
for (let i = 2; i <= 5; i++) {
  store.saveDiscovered(accA.id, PRODUCTS.map((p) => ({ ...p, subs: p.subs.map((s) => ({ ...s })) })));
  const ids = store.data.products.map((p) => p.id);
  const uniq = new Set(ids).size === ids.length;
  check(`第 ${i} 次抓取后无重复`, store.data.products.length === 2 && uniq,
    `共 ${store.data.products.length} 个，唯一 id ${new Set(ids).size}`);
}
check('套餐 id 保持稳定（客户端地址不失效）', store.data.products[0].id === idFirst);
check('订阅 token 保持稳定', store.data.products[0].subs[0].token === tokenFirst);

/* ---- 同机场多账号：相同 serviceId 共存 ---- */
store.saveDiscovered(accB.id, PRODUCTS.map((p) => ({ ...p, subs: p.subs.map((s) => ({ ...s })) })));
check('账号 B 抓取后共 4 个套餐', store.data.products.length === 4, String(store.data.products.length));
const pairKeys = store.data.products.map((p) => `${p.accountId}|${p.serviceId}`);
check('（账号, 套餐）组合唯一', new Set(pairKeys).size === 4);

/* ---- 账号 B 的重复抓取不影响账号 A ---- */
store.saveDiscovered(accB.id, PRODUCTS.map((p) => ({ ...p, subs: p.subs.map((s) => ({ ...s })) })));
check('账号 B 重复抓取后仍 4 个', store.data.products.length === 4, String(store.data.products.length));
check('账号 A 的套餐还在', store.data.products.filter((p) => p.accountId === accA.id).length === 2);

/* ---- 临时下架的套餐保留 ---- */
store.saveDiscovered(accA.id, [PRODUCTS[0]]);
const aProducts = store.data.products.filter((p) => p.accountId === accA.id);
check('未抓到的旧套餐保留（临时下架）', aProducts.length === 2, String(aProducts.length));
check('总量不变', store.data.products.length === 4, String(store.data.products.length));

/* ---- 删除账号连带删套餐 ---- */
store.saveAccounts([{ name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: 'pw1' }]);
check('删除账号后其套餐一并移除', store.data.products.every((p) => p.accountId === accA.id));

/* ---- token 轮换 ---- */
store.saveAccounts([
  { name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: 'pw1' },
  { name: '花云小号', baseUrl: 'https://api-flowercloud.com', email: 'b@x.com', password: 'pw2' },
]);
store.saveDiscovered(accA.id, PRODUCTS.map((p) => ({ ...p, subs: p.subs.map((s) => ({ ...s })) })));
const sub = store.listSubs()[0];
const oldToken = sub.sub.token;
const newToken = store.regenerateSubToken(sub.key);
check('token 轮换成功且变化', !!newToken && newToken !== oldToken);
check('轮换后旧 token 不再存在', !store.listSubs().some((e) => e.sub.token === oldToken));

/* ---- 同一登录不允许提交两次（两条全新条目，服务端兜底） ---- */
let dupMsg = '';
try {
  store.saveAccounts([
    { name: '重复A', baseUrl: 'https://api-flowercloud.com', email: 'dup@x.com', password: 'pw' },
    { name: '重复B', baseUrl: 'https://api-flowercloud.com/', email: 'dup@x.com', password: 'pw' },
  ]);
} catch (e) {
  dupMsg = e.message;
}
check('两条全新同登录条目被拒绝（地址归一后命中）', dupMsg.includes('同一个登录'), dupMsg);
check('被拒后账号未写入', !store.data.accounts.some((a) => a.email === 'dup@x.com'));
check('被拒后原有账号保持不变', store.data.accounts.some((a) => a.email === 'a@x.com'));

/* ---- /sub 回源顺带同步流量（state.syncTrafficFromSubFetch） ---- */
const { syncTrafficFromSubFetch } = await import('../src/state.js');
const syncP = store.data.products[0];
const SYNC_HDR = 'upload=1073741824; download=9663676416; total=161061273600; expire=1798761600';
check('回源同步：无头/未知套餐不报错', (syncTrafficFromSubFetch(syncP.id, ''), syncTrafficFromSubFetch('no-such', SYNC_HDR), true));
check('回源同步：此前流量为空', syncP.traffic === null, JSON.stringify(syncP.traffic));
syncTrafficFromSubFetch(syncP.id, SYNC_HDR);
check('回源同步：首次写入流量', syncP.traffic && syncP.traffic.total === 161061273600, JSON.stringify(syncP.traffic));
check('回源同步：时间戳已更新', syncP.trafficUpdatedAt > 0);
syncTrafficFromSubFetch(syncP.id, SYNC_HDR);
check('回源同步：数值未变不重写（值保持）', syncP.traffic.total === 161061273600);
syncTrafficFromSubFetch(syncP.id, 'upload=1; download=2; total=999');
check('回源同步：节流期内变更被推迟（仍为旧值）', syncP.traffic.total === 161061273600, String(syncP.traffic.total));

/* ---- 重复套餐数据自愈：normalize 去重而不是崩溃 ---- */
const withDup = {
  version: 1,
  accounts: [{ name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: 'pw' }],
  products: [
    { id: 'p1', accountId: '', serviceId: '409808', name: 'Lite', subs: [{ id: 's1', name: 'Clash', url: 'https://u/1', token: 'aaaaaaaabbbbbbbbcccccccc' }] },
    { id: 'p1', accountId: '', serviceId: '409808', name: 'Lite 重复', subs: [{ id: 's2', name: 'Clash', url: 'https://u/2', token: 'aaaaaaaabbbbbbbbdddddddd' }] },
  ],
};
let healed;
let dupError = '';
try { healed = normalize(withDup); } catch (e) { healed = null; dupError = e.message; }
check('含重复套餐的配置能正常 normalize', !!healed, dupError || '');
check('重复套餐被去重（保留第一条）', healed && healed.products.length === 1, healed ? String(healed.products.length) : '');
check('去重后 products 是数组且字段完整', healed && Array.isArray(healed.products) && healed.products[0].subs.length === 1);

/* ---- 密码可逆加密存储（密钥按邮箱派生，导出文件跨设备可解） ---- */
store.saveAccounts([
  { name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: '明文测试123' },
]);
const savedAcc = store.data.accounts[0];
check('落盘密码是密文格式（enc:）', savedAcc.password.startsWith('enc:'));
check('plainPassword 能还原明文', store.plainPassword(savedAcc) === '明文测试123');
const onDisk = fs.readFileSync(tmpFile, 'utf8');
check('配置文件里不再出现明文密码', !onDisk.includes('明文测试123'));
check('所有落盘密码均为密文', JSON.parse(onDisk).accounts.every((a) => !a.password || a.password.startsWith('enc:')));
// 幂等：把密文再喂回去不会被二次加密
const again = store.saveAccounts([
  { id: savedAcc.id, name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: savedAcc.password },
]);
check('密文再保存不会二次加密', again[0].password === savedAcc.password);
// 跨设备：密文不依赖 sessionSecret —— 改掉它之后仍能解开
const realSecret = store.data.sessionSecret;
store.data.sessionSecret = 'f'.repeat(64);
check('sessionSecret 变了仍能解密（密钥只由邮箱派生）', store.plainPassword(savedAcc) === '明文测试123');
// 换设备导入：全新 sessionSecret + 只有导出的账号，也能解
const imported = store.saveAccounts([
  { name: '花云', baseUrl: 'https://api-flowercloud.com', email: 'a@x.com', password: savedAcc.password },
]);
check('导入的密文在全新 sessionSecret 下可解', store.plainPassword(imported[0]) === '明文测试123');
store.data.sessionSecret = realSecret;

/* ---- 管理口令策略与存储 ---- */
check('策略：<8 位拒绝', validateAdminPassword('Ab1') !== '');
check('策略：无数字拒绝', validateAdminPassword('Abcdefgh') !== '');
check('策略：无大写拒绝', validateAdminPassword('abcdefg1') !== '');
check('策略：无小写拒绝', validateAdminPassword('ABCDEFG1') !== '');
check('策略：合规通过', validateAdminPassword('DevAdmin123') === '');
store.setAdminPassword('DevAdmin123');
check('管理口令明文落盘（便于本地找回）', store.data.adminPassword === 'DevAdmin123');
check('plainAdminPassword 返回明文', store.plainAdminPassword() === 'DevAdmin123');
const diskPw = JSON.parse(fs.readFileSync(tmpFile, 'utf8')).adminPassword;
check('配置文件里可直接读到管理口令', diskPw === 'DevAdmin123');

fs.rmSync(tmpFile, { force: true });
console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
process.exit(fail ? 1 : 0);