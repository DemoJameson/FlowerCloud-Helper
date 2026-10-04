/**
 * 定时「刷新全部」的回归测试（离线，不联网、不碰生产配置）。
 *   npm run test:auto-refresh
 *
 * 钉住三件事：
 *   1. 间隔配置：全新配置默认 20 分钟、非法值只收敛不抛错、0 = 关闭
 *   2. 循环本身：一轮刷新失败（这里把 fetch 打成拒绝，等价于 FlareSolverr
 *      不可达）也必须记下状态、排上下一次 —— 一次异常就永久停摆是本功能
 *      最怕的事（用户不会收到任何提示，只会悄悄不再刷新）
 *   3. 关闭 / stopAutoRefresh 之后确实不再触发
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store 是读取 env 后实例化的单例，必须先指到临时文件再 import
const tmpFile = path.join(os.tmpdir(), `fc-auto-refresh-${process.pid}.json`);
fs.rmSync(tmpFile, { force: true });
process.env.CONFIG_FILE = tmpFile;
// 兜底：万一桩没拦住某个请求，也只是连本机空端口立刻失败，不会出网
process.env.FLARESOLVERR_URL = 'http://127.0.0.1:9';

// 离线桩：任何 fetch 直接失败。刷新流程会走到这里（连不上 FlareSolverr），
// 于是调度器走「本轮失败 → 记状态 → 继续排下一轮」的分支。
globalThis.fetch = async () => {
  throw new TypeError('fetch failed');
};

const { store, normalizeAutoRefreshMinutes, validateAutoRefreshMinutes, DEFAULT_AUTO_REFRESH_MINUTES } =
  await import('../src/store.js');
const { startAutoRefresh, stopAutoRefresh, autoRefreshStatus } = await import('../src/scheduler.js');
const { withRefreshMarker, refreshInProgress } = await import('../src/state.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/* ---- 1. 间隔配置 ---- */

check('默认间隔 20 分钟', store.data.autoRefreshMinutes === DEFAULT_AUTO_REFRESH_MINUTES, String(store.data.autoRefreshMinutes));
check('默认间隔为 20', DEFAULT_AUTO_REFRESH_MINUTES === 20);

// 手改配置写坏了不能让服务起不来 —— 只收敛，不抛错
check('非数字 → 默认值', normalizeAutoRefreshMinutes('abc') === DEFAULT_AUTO_REFRESH_MINUTES);
check('空值 → 默认值', normalizeAutoRefreshMinutes('') === DEFAULT_AUTO_REFRESH_MINUTES);
check('负数 → 0（关闭）', normalizeAutoRefreshMinutes(-5) === 0);
check('超大值 → 截断到 1 天', normalizeAutoRefreshMinutes(99999) === 1440);
check('小数 → 取整', normalizeAutoRefreshMinutes(7.6) === 8);
check('0 保持 0', normalizeAutoRefreshMinutes('0') === 0);

// 管理页提交走严格校验，给出能照着改的提示
check('校验：合法值通过', validateAutoRefreshMinutes(20) === '');
check('校验：0（关闭）通过', validateAutoRefreshMinutes('0') === '');
check('校验：非数字报错', validateAutoRefreshMinutes('abc') !== '');
check('校验：超上限报错', validateAutoRefreshMinutes(99999) !== '');

// 改了要落盘：重新读一份配置回来验证
store.setAutoRefreshMinutes(30);
const reread = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
check('间隔变更已落盘', reread.autoRefreshMinutes === 30, String(reread.autoRefreshMinutes));

/* ---- 2. 关闭状态：不排任何一次 ---- */

store.setAutoRefreshMinutes(0);
check('间隔 0 时 startAutoRefresh 返回 false', startAutoRefresh({ firstDelayMs: 10 }) === false);
await sleep(200);
check('关闭时不触发刷新', autoRefreshStatus().runs === 0, `runs=${autoRefreshStatus().runs}`);
check('关闭时 nextRunAt 为空', autoRefreshStatus().nextRunAt === null);
check('关闭时 enabled=false', autoRefreshStatus().enabled === false);

/* ---- 3. 循环：失败也要继续排下一轮 ---- */

store.saveAccounts([
  { name: '测试机场', baseUrl: 'https://panel.example.com', email: 'a@example.com', password: 'Secret123' },
]);
check('已写入测试账号', store.data.accounts.length === 1);

// 直接改内存字段把间隔压到 1.2 秒（normalize 会取整，正常配置里不会是小数）
store.data.autoRefreshMinutes = 0.02;
startAutoRefresh({ firstDelayMs: 50 });
check('开启后返回 true', autoRefreshStatus().enabled === true);

const ran = await waitFor(() => autoRefreshStatus().runs >= 2);
const st = autoRefreshStatus();
check('定时刷新跑起来了', ran, `runs=${st.runs}`);
check('本轮失败被记下（lastOk=false）', st.lastOk === false);
check('失败原因已记录', !!st.lastError, st.lastError);
check('跑完 running 复位', st.running === false);
check('失败后仍排了下一次', !!st.nextRunAt, String(st.nextRunAt));
check('跑了不止一轮（没有一次失败就停摆）', st.runs >= 2, `runs=${st.runs}`);

/* ---- 4. 没配账号时整轮跳过（不空转刷新） ---- */

const savedAccounts = store.data.accounts;
const runsBefore = autoRefreshStatus().runs;
store.data.accounts = [];
const skipped = await waitFor(() => autoRefreshStatus().skipped > 0);
check('无账号时跳过本轮', skipped, `skipped=${autoRefreshStatus().skipped}`);
check('跳过不算作一轮刷新', autoRefreshStatus().runs === runsBefore);
store.data.accounts = savedAccounts;

/* ---- 5. 刷新进行中 → 整轮跳过（否则两边抢同一条 FlareSolverr 会话） ----
 * 仪表盘的「刷新全部」是前端按账号连打 /refresh，不走 refreshAll；
 * 手动刷的那几分钟里若定时那一轮照跑，就是纯排队白耗机场配额。 */

check('空闲时 refreshInProgress=false', refreshInProgress() === false);
let release = null;
const marked = withRefreshMarker(new Promise((r) => { release = r; }));
check('标记期间 refreshInProgress=true', refreshInProgress() === true);

const runsBeforeSkip = autoRefreshStatus().runs;
const skippedBefore = autoRefreshStatus().skipped;
const gotSkip = await waitFor(() => autoRefreshStatus().skipped > skippedBefore);
check('刷新进行中时跳过定时那一轮', gotSkip, `skipped=${autoRefreshStatus().skipped}`);
check('跳过的这一轮没有被真的跑掉', autoRefreshStatus().runs === runsBeforeSkip, `runs=${autoRefreshStatus().runs}`);

release();
await marked;
check('标记解除后 refreshInProgress=false', refreshInProgress() === false);

/* ---- 6. stopAutoRefresh 之后不再触发 ---- */

stopAutoRefresh();
const runsAfterStop = autoRefreshStatus().runs;
await sleep(500); // 远大于 1.2 秒的间隔
check('停止后不再触发', autoRefreshStatus().runs === runsAfterStop, `runs=${autoRefreshStatus().runs}`);
check('停止后 nextRunAt 清空', autoRefreshStatus().nextRunAt === null);

stopAutoRefresh();
fs.rmSync(tmpFile, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
