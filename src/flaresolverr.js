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

/** Cloudflare 人机验证的页面特征 */
const CF_RE = /just a moment|checking your browser|请稍候|验证|cf-chl|challenge-platform|turnstile/i;

/* ------------------------------------------------------------------ */
/* 与 FlareSolverr 的 HTTP 交互                                          */
/* ------------------------------------------------------------------ */

async function call(payload, timeoutMs = config.cfTimeoutMs) {
  const url = `${API()}/v1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
    const json = await res.json();
    // status: ok | error
    if (json.status !== 'ok') {
      const msg = json.message || json.error || '未知错误';
      throw new Error(`FlareSolverr: ${msg}`);
    }
    return json.solution || {};
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
  const opts = timeoutMs ? { maxTimeout: Math.ceil(timeoutMs / 1000) } : {};
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
  const opts = timeoutMs ? { maxTimeout: Math.ceil(timeoutMs / 1000) } : {};
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