/**
 * FlareSolverr 客户端
 *
 * 花云（api-flowercloud.com）这类机场在 Cloudflare 后面，直接用 fetch
 * 会被人机验证拦住。FlareSolverr 用真实浏览器过验证后，把 cookie 交给本服务，
 * 之后的请求就都是普通 HTTP，不再需要在本机跑 Chromium。
 *
 * 用到的四个命令：
 *   sessions.create   开会话（复用 cf_clearance）
 *   sessions.destroy  关会话（被验证拦住时重建 / 进程退出时释放）
 *   request.get       GET 任意页面，返回 HTML + cookie
 *   request.post      POST 表单（登录）
 *
 * 会话失效时（返回 403/503 或页面含验证特征）自动重建一次再重试。
 */
import { config } from './config.js';
import { log } from './logtime.js';

const API = () => (config.flareSolverrUrl || 'http://flaresolverr:8191').replace(/\/+$/, '');

/**
 * Cloudflare 人机验证页面的特征。
 *
 * ⚠️ 只认「挑战页独有」的标记：正常页面里也会出现 `challenge-platform`
 * （CF 注入的 jsd 脚本，花云登录页末尾就有一处）和普通的中文「验证」字样，
 * 拿它们做判断会把放行成功的页面又当成拦截，白白重建会话。
 */
const CF_RE = /<title>\s*(just a moment|checking your browser)|window\._cf_chl_opt|cf-chl-|id=["']challenge-form/i;

/* ------------------------------------------------------------------ */
/* 与 FlareSolverr 的 HTTP 交互                                          */
/* ------------------------------------------------------------------ */

/**
 * 本端比 FlareSolverr 多等的余量：让对面先把「为什么失败」说出来，
 * 而不是被我们抢先 abort 成一句没有信息量的超时。
 */
const CLIENT_GRACE_MS = 5000;

async function call(payload, timeoutMs = config.cfTimeoutMs) {
  const url = `${API()}/v1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + CLIENT_GRACE_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    // FlareSolverr 失败时同样是 JSON —— HTTP 500 + {status:'error', message:'...'}。
    // 只按 !res.ok 抛状态码，就会把「Timeout after 60s」这类真原因丢掉，
    // 日志里只剩一句 FlareSolverr HTTP 500，等于什么都没说。
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object') {
      const detail = String(text || '').trim().slice(0, 200);
      throw new Error(`FlareSolverr HTTP ${res.status}${detail ? `：${detail}` : '（空响应）'}`);
    }
    // status: ok | error
    if (json.status !== 'ok') {
      const msg = json.message || json.error || `HTTP ${res.status}`;
      throw new Error(`FlareSolverr: ${msg}`);
    }
    return json.solution || {};
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`FlareSolverr 请求超时（本端等了 ${Math.round(timeoutMs / 1000)}s）`, { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 会话管理                                                             */
/* ------------------------------------------------------------------ */

let sessionId = null;
let creating = null;

/** 懒加载会话，并发调用共享同一个 Promise */
async function ensureSession() {
  if (sessionId) return sessionId;
  if (!creating) {
    creating = (async () => {
      // 用固定名字：进程重启后若 FlareSolverr 还在，旧会话可直接复用
      const name = `flowercloud-${config.sessionIdSuffix}`;
      try {
        // 先清掉同名残留会话，避免 reuse 导致状态错乱
        await call({ cmd: 'sessions.destroy', session: name }, 15000).catch(() => {});
        await call({ cmd: 'sessions.create', session: name }, 30000);
        sessionId = name;
        log('[cf] FlareSolverr 会话已创建');
        return sessionId;
      } finally {
        creating = null;
      }
    })();
  }
  return creating;
}

async function destroySession() {
  if (!sessionId) return;
  const id = sessionId;
  sessionId = null;
  await call({ cmd: 'sessions.destroy', session: id }, 15000).catch(() => {});
  log('[cf] FlareSolverr 会话已关闭');
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

/** 把 FlareSolverr 返回的 cookie 数组转成 Cookie 请求头 */
function cookieHeader(solution) {
  const list = solution.cookies || [];
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 页面是否停在人机验证上 */
function blocked(solution) {
  const html = String(solution.response || '');
  const code = Number(solution.status);
  if (code === 403 || code === 503) return true;
  return CF_RE.test(html.slice(0, 3000));
}

/**
 * 带 CF 放行的 GET。返回 { html, cookies, status, url }
 * 首次若被验证拦住，会话重建后再试一次。
 */
export async function get(url, { session = true, timeoutMs } = {}) {
  // ⚠️ maxTimeout 的单位是**毫秒**（FlareSolverr 直接拿它当内部 deadline）。
  // 两处历史坑：① 曾写成 Math.ceil(ms/1000)，120000 变成 120，对面立刻回
  // 「Timeout after 0.12 seconds」；② 曾只在显式传 timeoutMs 时才填，于是所有
  // 调用都落回 FlareSolverr 自己的 60s 默认值 —— FLARESOLVERR_TIMEOUT_MS=120000
  // 只作用在本端 fetch 的 abort 上，从来没告诉过对面。现在一律按配置发过去。
  const opts = { maxTimeout: timeoutMs || config.cfTimeoutMs };
  let solution = await call({ cmd: 'request.get', url, ...opts, session: session ? await ensureSession() : undefined });

  if (blocked(solution)) {
    log('[cf] 被人机验证拦住，重建会话后重试…');
    await destroySession();
    solution = await call({
      cmd: 'request.get',
      url,
      ...opts,
      session: session ? await ensureSession() : undefined,
    });
    if (blocked(solution)) {
      throw new Error(
        'Cloudflare 人机验证未通过。FlareSolverr 也没能放行，通常是该机场的防护规则较严' +
          '（或需要较长时间）。可稍后重试，或在 compose 里给 FlareSolverr 配代理。'
      );
    }
  }

  return {
    html: String(solution.response || ''),
    cookies: cookieHeader(solution),
    status: Number(solution.status) || 200,
    url: solution.url || url,
  };
}

/**
 * 带 CF 放行的 POST 表单（登录用）。
 * FlareSolverr 的 request.post 会自动处理 WHMCS 的 CSRF token —— 前提是
 * 先 GET 一次登录页拿到 token 和 cookie，再带着它们 POST。
 */
export async function post(url, fields, { timeoutMs } = {}) {
  const opts = { maxTimeout: timeoutMs || config.cfTimeoutMs };
  let solution = await call({
    cmd: 'request.post',
    url,
    postData: new URLSearchParams(fields).toString(),
    ...opts,
    session: await ensureSession(),
  });

  if (blocked(solution)) {
    log('[cf] POST 被人机验证拦住，重建会话后重试…');
    await destroySession();
    solution = await call({
      cmd: 'request.post',
      url,
      postData: new URLSearchParams(fields).toString(),
      ...opts,
      session: await ensureSession(),
    });
    if (blocked(solution)) {
      throw new Error('Cloudflare 人机验证未通过，无法提交登录表单。');
    }
  }

  return {
    html: String(solution.response || ''),
    cookies: cookieHeader(solution),
    status: Number(solution.status) || 200,
    url: solution.url || url,
  };
}

/** 关掉会话（进程退出时调用，别让 FlareSolverr 那边留着空会话） */
export async function closeSession() {
  await destroySession();
}