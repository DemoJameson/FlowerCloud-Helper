/**
 * FlareSolverr 客户端的回归测试（离线，不联网）。
 *   node test/flaresolverr.test.mjs
 *
 * 钉住三件曾经出过事的地方：
 *   1. maxTimeout 的单位必须是**毫秒**。写成秒时 120000 变成 120，
 *      对面直接回「Timeout after 0.12 seconds」——每次刷新注定失败。
 *   2. HTTP 500 的响应体是 JSON，里面的 message 才是真原因，
 *      不能只抛一个光秃秃的状态码。
 *   3. 正常页面里 CF 也会注入 challenge-platform 脚本，
 *      不能据此把放行成功的页面判成拦截页、白白重建会话。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = path.join(os.tmpdir(), `fc-flaresolverr-${process.pid}.json`);
fs.rmSync(tmpFile, { force: true });
process.env.CONFIG_FILE = tmpFile;
process.env.FLARESOLVERR_URL = 'http://flaresolverr.test:8191';
process.env.FLARESOLVERR_TIMEOUT_MS = '120000';
process.env.SESSION_SUFFIX = 'test';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

/* ---------------- 假的 FlareSolverr ---------------- */

const calls = [];
/** 按队列返回下一次 request.get 的响应 */
let getQueue = [];

function solution(status, html, url = 'https://api-flowercloud.com/clientarea.php') {
  return { url, status, headers: {}, response: html, cookies: [], userAgent: 'ua' };
}

function ok(body) {
  return { status: 200, body: JSON.stringify({ status: 'ok', message: '', solution: body }) };
}

function err(status, message) {
  return { status, body: JSON.stringify({ status: 'error', message, solution: solution(0, '') }) };
}

globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  calls.push(payload);
  const reply = (() => {
    if (payload.cmd === 'sessions.create') return ok({});
    if (payload.cmd === 'sessions.destroy') return ok({});
    if (payload.cmd === 'request.get') return getQueue.shift() ?? ok(solution(200, '<html>默认页</html>'));
    return ok({});
  })();
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: async () => reply.body,
  };
};

const fsp = await import('../src/flaresolverr.js');

/* ---------------- 1. maxTimeout 用毫秒 ---------------- */

getQueue = [ok(solution(200, '<html><title>客户中心</title></html>'))];
await fsp.get('https://api-flowercloud.com/clientarea.php');
const firstGet = calls.find((c) => c.cmd === 'request.get');
check('maxTimeout 传给 FlareSolverr 的是毫秒', firstGet?.maxTimeout === 120000, String(firstGet?.maxTimeout));
check('没有把毫秒除成秒', firstGet?.maxTimeout !== 120);

/* ---------------- 2. HTTP 500 要带出对面的原因 ---------------- */

getQueue = [err(500, 'Error solving the challenge. Timeout after 60.0 seconds.')];
let caught = null;
try {
  await fsp.get('https://api-flowercloud.com/clientarea.php');
} catch (e) {
  caught = e;
}
check('HTTP 500 抛错', !!caught);
check('错误里带上 FlareSolverr 的 message', /Timeout after 60/.test(caught?.message || ''), caught?.message);
check('错误不是只有状态码', (caught?.message || '') !== 'FlareSolverr HTTP 500', caught?.message);

/* ---------------- 3. 正常页面不因 challenge-platform 被误判 ---------------- */

const realPage =
  '<html><head><title>客户中心 - FlowerCloud</title></head><body>' +
  '<a href="clientarea.php?action=productdetails&amp;id=409808">套餐</a>' +
  '<script>var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";' +
  'document.getElementsByTagName("head")[0].appendChild(a);</script></body></html>';

const before = calls.filter((c) => c.cmd === 'request.get').length;
const destroysBefore = calls.filter((c) => c.cmd === 'sessions.destroy').length;
getQueue = [ok(solution(200, realPage))];
const page = await fsp.get('https://api-flowercloud.com/clientarea.php');
const after = calls.filter((c) => c.cmd === 'request.get').length;
const destroysAfter = calls.filter((c) => c.cmd === 'sessions.destroy').length;
check('正常页面被当成成功返回', /套餐/.test(page.html));
check('没有为它多发一次请求', after - before === 1, `${after - before} 次`);
check('没有重建会话', destroysAfter === destroysBefore, `${destroysAfter - destroysBefore} 次 destroy`);

/* ---------------- 4. 真拦截页才重建会话 ---------------- */

const challengePage =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<script>window._cf_chl_opt={};</script></body></html>';

getQueue = [ok(solution(403, challengePage)), ok(solution(200, realPage))];
const destroysBefore2 = calls.filter((c) => c.cmd === 'sessions.destroy').length;
const got = await fsp.get('https://api-flowercloud.com/clientarea.php');
const destroysAfter2 = calls.filter((c) => c.cmd === 'sessions.destroy').length;
check('拦截页触发重建后拿到真页面', /套餐/.test(got.html));
check('拦截页确实重建了会话', destroysAfter2 > destroysBefore2, `${destroysAfter2 - destroysBefore2} 次 destroy`);

/* ---------------- 5. 两次都被拦 → 抛可读错误 ---------------- */

getQueue = [ok(solution(403, challengePage)), ok(solution(403, challengePage))];
caught = null;
try {
  await fsp.get('https://api-flowercloud.com/clientarea.php');
} catch (e) {
  caught = e;
}
check('连续被拦时报错', !!caught);
check('报错提示 Cloudflare 未通过', /人机验证未通过|Cloudflare/i.test(caught?.message || ''), caught?.message);

await fsp.closeSession();
fs.rmSync(tmpFile, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
