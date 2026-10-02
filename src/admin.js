import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { store } from './store.js';
import { statusPayload } from './state.js';
import { validateAdminPassword } from './store.js';
import { log, dateOnly } from './logtime.js';

const COOKIE_NAME = 'hy_admin';
const SESSION_TTL_MS = Math.max(1, config.sessionTtlHours) * 3600 * 1000;
const MAX_ATTEMPTS = 10;
const LOCK_MS = 5 * 60 * 1000;
const MAX_DEBUG_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 定长哈希后比较，避免通过长度或短路时序泄漏信息 */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // 畸形百分号编码（如 %ZZ）不该让整个请求 500，按原值处理即可
      out[k] = v;
    }
  }
  return out;
}

function createSession() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, sid: crypto.randomUUID() })
  ).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', store.data.sessionSecret).update(payload).digest('base64url')}`;
}

// 服务端已注销的会话（sid -> 过期时间）：登出后旧 Cookie 立即失效，
// 不止是靠浏览器删 Cookie。重启后 Map 清空 = 全部会话失效，安全兜底。
const revokedSessions = new Map();

function parseSessionCookie(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = crypto.createHmac('sha256', store.data.sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function verifySession(req) {
  const data = parseSessionCookie(req);
  if (!data) return false;
  // 已在服务端注销的会话直接拒绝
  if (data.sid && revokedSessions.has(data.sid)) return false;
  return true;
}

/** 供其它模块复用：请求是否携带有效管理会话 */
export function hasValidSession(req) {
  return adminConfigured() && verifySession(req);
}

/* ---- 管理口令：首次访问由用户自主设置（可一键随机生成），存于配置文件 ---- */

function adminConfigured() {
  return !!store.data.adminPassword;
}

/** 当前生效的管理口令（明文存于配置文件 adminPassword 字段） */
function currentAdminPassword() {
  return store.plainAdminPassword();
}

/* ------------------------------------------------------------------ */
/* 登录限流（按客户端 IP）                                              */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { count, windowStart, lockedUntil }

/* ---- 客户端 IP 与 HTTPS 判定 ----
 * 规则一句话：请求确实来自本机/内网地址（即反代）时，才信任
 * X-Forwarded-* 转发头；对端是公网地址（直接暴露）时这些头可被
 * 伪造，一律不信任。这覆盖全部部署形态，无需任何配置：
 *   compose 内反代 → 内网对端   → 信任 ✓
 *   Cloudflare Tunnel → 本机回环 → 信任 ✓
 *   直连暴露 → 公网对端         → 不信任（防伪造绕过限流） */

function isPrivatePeer(req) {
  // IPv4-mapped IPv6（::ffff:192.168.x.x）先归一化
  const a = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return (
    a === '::1' ||
    a.startsWith('127.') ||
    a.startsWith('10.') ||
    a.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  );
}

function clientIp(req) {
  if (isPrivatePeer(req)) {
    const xff = req.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket?.encrypted) return true;
  if (isPrivatePeer(req)) return req.get('x-forwarded-proto') === 'https';
  return false;
}

function checkRate(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (rec.windowStart + LOCK_MS < now) {
    attempts.delete(ip);
  }
  return { allowed: true };
}

function recordFail(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || rec.windowStart + LOCK_MS < now) {
    rec = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
    log(`[admin] IP ${ip} 连续失败 ${rec.count} 次，锁定 ${LOCK_MS / 60000} 分钟`);
  }
  attempts.set(ip, rec);
}

// 定期清理，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (rec.windowStart + LOCK_MS < now && rec.lockedUntil < now) attempts.delete(ip);
  }
  for (const [sid, exp] of revokedSessions) {
    if (exp < now) revokedSessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('Cache-Control', 'no-store');
  // HTTPS 请求（含反代正确传 X-Forwarded-Proto 时）强制浏览器后续走 HTTPS
  if (isHttps(req)) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** 状态变更接口：校验来源，防 CSRF（配合 SameSite=Strict 双重保险） */
export function sameOriginOnly(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'cross-site request rejected' });
  }
  const origin = req.get('origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'bad origin' });
    }
    if (originHost !== req.get('host')) {
      return res.status(403).json({ error: 'origin mismatch' });
    }
  }
  next();
}

function requireAuth(req, res, next) {
  // 管理页唯一入口是浏览器会话 Cookie；机器接口走 /sub /status（订阅 token）
  if (hasValidSession(req)) return next();

  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

/* ------------------------------------------------------------------ */
/* 静态资源（不含任何机密，可公开）                                      */
/* ------------------------------------------------------------------ */

const STYLE = `
/* ============================================================
   设计令牌
   ============================================================ */
:root{
  color-scheme:dark;
  --bg:#0a0d13;
  --bg-grad:
    radial-gradient(1100px 620px at 12% -12%,rgba(91,140,255,.16),transparent 62%),
    radial-gradient(900px 520px at 102% -4%,rgba(124,92,255,.14),transparent 58%);
  --surface:#121826;
  --surface-2:#18203180;
  --surface-solid:#182031;
  --surface-3:#1f293c;
  --line:#253148;
  --line-soft:#1b2434;
  --fg:#e9eefa;
  --dim:#a9b4c9;
  --muted:#7c8aa3;
  --accent:#5b8cff;
  --accent-2:#8b6cff;
  --accent-soft:rgba(91,140,255,.14);
  --ok:#34d99b;
  --warn:#f7b955;
  --err:#ff6b70;
  --r-lg:16px;--r:12px;--r-sm:9px;
  --shadow:inset 0 1px 0 rgba(255,255,255,.04),0 14px 34px -22px rgba(0,0,0,.95);
  --ring:0 0 0 3px rgba(91,140,255,.30);
  --head-h:60px;
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --bg:#f4f6fb;
    --bg-grad:
      radial-gradient(1100px 620px at 12% -12%,rgba(91,140,255,.14),transparent 62%),
      radial-gradient(900px 520px at 102% -4%,rgba(139,108,255,.12),transparent 58%);
    --surface:#ffffff;
    --surface-2:#ffffffcc;
    --surface-solid:#ffffff;
    --surface-3:#eef2f9;
    --line:#dde4ef;
    --line-soft:#e7ecf4;
    --fg:#101725;
    --dim:#48566e;
    --muted:#6b7a93;
    --accent:#3565e8;
    --accent-2:#6d4bf0;
    --accent-soft:rgba(53,101,232,.10);
    --ok:#12a06a;
    --warn:#b7791f;
    --err:#d63b40;
    --shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 28px -20px rgba(16,23,37,.45);
    --ring:0 0 0 3px rgba(53,101,232,.22);
  }
}

*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;
  background-color:var(--bg);background-image:var(--bg-grad);
  background-attachment:fixed;background-repeat:no-repeat;
  color:var(--fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
::selection{background:var(--accent-soft);color:var(--fg)}
:focus-visible{outline:none;box-shadow:var(--ring);border-radius:var(--r-sm)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{margin:0;font-weight:650;letter-spacing:-.01em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px}

/* ============================================================
   顶栏
   ============================================================ */
.topbar{
  position:sticky;top:0;z-index:40;height:var(--head-h);
  background:var(--surface-2);
  -webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);
  border-bottom:1px solid var(--line-soft);
}
.topbar-in{
  max-width:1180px;height:100%;margin:0 auto;padding:0 20px;
  display:flex;align-items:center;gap:10px;
}
.brand{display:flex;align-items:center;gap:10px;margin-right:6px;min-width:0}
.brand-text{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.brand-mark{
  width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;
  background:linear-gradient(140deg,var(--accent),var(--accent-2));
  box-shadow:0 6px 16px -8px var(--accent);
}
.brand-mark svg{display:block}
.brand-name{font-size:14.5px;font-weight:680;white-space:nowrap}
.brand-sub{font-size:11px;color:var(--muted);white-space:nowrap}

.tabs{display:flex;gap:2px;padding:3px;border-radius:11px;background:var(--surface-3);margin-left:6px}
.tab{
  padding:6px 14px;border-radius:8px;font-size:13px;font-weight:550;
  color:var(--muted);transition:background .15s,color .15s;white-space:nowrap;
}
.tab:hover{color:var(--fg);text-decoration:none}
.tab.active{background:var(--surface-solid);color:var(--fg);box-shadow:0 2px 8px -4px rgba(0,0,0,.6)}

.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}

/* ============================================================
   布局
   ============================================================ */
.shell{max-width:1180px;margin:0 auto;padding:24px 20px 72px}
.section{margin-top:28px}
.section:first-child{margin-top:0}
.section-head{
  display:flex;align-items:baseline;gap:6px 12px;flex-wrap:wrap;margin-bottom:12px;
}
.section-head h2{font-size:17px;white-space:nowrap}
.section-head .hint-text{font-size:12.5px;color:var(--muted);flex:1 1 260px;min-width:0}
.section-head .spacer{flex:1}

.card{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:18px;box-shadow:var(--shadow);
}
.card-title{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:650;margin-bottom:12px}

/* ============================================================
   按钮 / 表单
   ============================================================ */
button{font-family:inherit}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  border:1px solid transparent;border-radius:10px;
  padding:8px 14px;font-size:13px;font-weight:550;line-height:1.2;
  background:linear-gradient(140deg,var(--accent),var(--accent-2));color:#fff;
  cursor:pointer;transition:filter .15s,transform .06s,background .15s,border-color .15s;
  white-space:nowrap;
}
.btn:hover:not(:disabled){filter:brightness(1.08)}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn:disabled{opacity:.45;cursor:default}
.btn.ghost{background:var(--surface-3);border-color:var(--line);color:var(--fg)}
.btn.ghost:hover:not(:disabled){background:var(--line-soft);border-color:var(--accent)}
.btn.danger{background:transparent;border-color:color-mix(in srgb,var(--err) 45%,transparent);color:var(--err)}
.btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--err) 12%,transparent)}
.btn.sm{padding:5px 10px;font-size:12px;border-radius:8px}
.btn.icon{padding:6px;width:28px;height:28px}
.btn.icon svg{display:block}

label{display:block;font-size:12px;font-weight:550;color:var(--muted);margin:0 0 6px}
input,select,textarea{
  width:100%;background:var(--bg);border:1px solid var(--line);color:var(--fg);
  border-radius:10px;padding:9px 11px;font-size:13.5px;font-family:inherit;
  transition:border-color .15s,box-shadow .15s;
}
input::placeholder{color:var(--muted);opacity:.75}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
input[type=checkbox]{width:auto;accent-color:var(--accent)}
label.check{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--fg);margin:0;cursor:pointer;font-weight:500}
label.check input{cursor:pointer}
.hint{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.5}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stack{display:flex;flex-direction:column;gap:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ============================================================
   通用小件
   ============================================================ */
.muted{color:var(--muted)}
.dim{color:var(--dim)}
.sm{font-size:12.5px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;background:var(--muted)}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 22%,transparent)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 22%,transparent)}
.dot.err{background:var(--err);box-shadow:0 0 0 3px color-mix(in srgb,var(--err) 22%,transparent)}
.dot.busy{background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

.badge{
  display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
  font-size:11.5px;font-weight:600;line-height:1.7;white-space:nowrap;
  border:1px solid transparent;
}
.badge.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.badge.warn{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn);border-color:color-mix(in srgb,var(--warn) 32%,transparent)}
.badge.err{background:color-mix(in srgb,var(--err) 14%,transparent);color:var(--err);border-color:color-mix(in srgb,var(--err) 32%,transparent)}
.badge.idle{background:var(--surface-3);color:var(--muted);border-color:var(--line)}
.badge.accent{background:var(--accent-soft);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 32%,transparent)}

.banner{
  border:1px solid;border-radius:var(--r);padding:12px 14px;font-size:13px;
  display:flex;gap:10px;align-items:flex-start;line-height:1.6;
}
.banner .banner-body{flex:1;min-width:0}
.banner ul{margin:0;padding-left:18px}
.banner li+li{margin-top:4px}
.banner.warn{background:color-mix(in srgb,var(--warn) 9%,transparent);border-color:color-mix(in srgb,var(--warn) 32%,transparent);color:color-mix(in srgb,var(--warn) 82%,var(--fg))}
.banner.err{background:color-mix(in srgb,var(--err) 9%,transparent);border-color:color-mix(in srgb,var(--err) 32%,transparent);color:color-mix(in srgb,var(--err) 82%,var(--fg))}
.banner.ok{background:color-mix(in srgb,var(--ok) 9%,transparent);border-color:color-mix(in srgb,var(--ok) 30%,transparent);color:color-mix(in srgb,var(--ok) 82%,var(--fg))}
.banner.info{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 30%,transparent);color:var(--dim)}

.kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:12.5px;align-items:baseline}
.kv+.kv{border-top:1px solid var(--line-soft)}
.kv>span:first-child{color:var(--muted);flex:none}
.kv>span:last-child{text-align:right;min-width:0;word-break:break-word}

.empty{
  text-align:center;padding:44px 20px;color:var(--muted);
  border:1px dashed var(--line);border-radius:var(--r-lg);background:var(--surface-2);
}
.empty strong{display:block;color:var(--fg);font-size:15px;margin-bottom:6px;font-weight:600}

details.fold{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);overflow:hidden}
details.fold>summary{
  list-style:none;cursor:pointer;padding:12px 16px;display:flex;align-items:center;gap:10px;
  font-size:13.5px;font-weight:600;user-select:none;
}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:"▸";margin-left:auto;color:var(--muted);transition:transform .18s}
details.fold[open]>summary::after{transform:rotate(90deg)}
details.fold>summary:hover{background:var(--surface-3)}
details.fold .fold-body{padding:0 16px 16px;border-top:1px solid var(--line-soft)}

/* ============================================================
   统计磁贴
   ============================================================ */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
.stats-full{grid-column:1/-1}
.stat{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:14px 16px;box-shadow:var(--shadow);position:relative;overflow:hidden;
}
.stat::after{
  content:"";position:absolute;inset:0 auto 0 0;width:3px;border-radius:3px 0 0 3px;
  background:var(--accent);opacity:.55;
}
.stat.ok::after{background:var(--ok)}
.stat.warn::after{background:var(--warn)}
.stat.err::after{background:var(--err)}
.stat-label{font-size:11.5px;color:var(--muted);font-weight:550;display:flex;align-items:center;gap:6px}
.stat-value{font-size:26px;font-weight:680;letter-spacing:-.02em;margin-top:6px;line-height:1.15;font-variant-numeric:tabular-nums}
.stat-value small{font-size:13px;font-weight:500;color:var(--muted);margin-left:3px}
.stat-foot{font-size:12px;color:var(--muted);margin-top:4px}

/* ============================================================
   机场 / 套餐 / 订阅
   ============================================================ */
.airport{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.airport + .airport{margin-top:14px}
.airport-head{
  display:flex;align-items:center;gap:10px;padding:14px 18px;
  background:linear-gradient(180deg,var(--surface-3),transparent);
  border-bottom:1px solid var(--line-soft);flex-wrap:wrap;
}
.airport-head h3{font-size:15px}
.airport-meta{font-size:12px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.airport-meta code{background:var(--surface-3);border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--dim)}
.airport-body{padding:16px 18px}

/* ---- 套餐级流量 + 订阅行列表 ---- */
.plan-traffic{padding:2px 0 12px;border-bottom:1px dashed var(--line);margin-bottom:12px}
.traffic-num{font-size:20px;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.2}
.traffic-num span{font-size:12.5px;font-weight:500;color:var(--muted)}
.sub-list{display:flex;flex-direction:column}
.sub-line{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-soft);flex-wrap:wrap}
.sub-line:last-child{border-bottom:0}
.sub-name{font-size:13.5px;font-weight:550;flex:0 0 auto;min-width:150px}
.sub-line .sub-url{flex:1;min-width:260px;display:flex;gap:6px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:5px 5px 5px 9px}
.sub-line .sub-url code{flex:1;min-width:0;background:none;border:none;padding:0;color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub-err{border-color:color-mix(in srgb,var(--err) 34%,var(--line))}
.account-group{margin-bottom:22px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface-2);box-shadow:var(--shadow);overflow:hidden}
.grp-head{display:flex;align-items:center;gap:10px;padding:13px 18px;background:linear-gradient(180deg,var(--surface-3),transparent);border-bottom:1px solid var(--line-soft);flex-wrap:wrap}
.grp-name{font-size:15.5px}
.grp-url{background:var(--surface-3);border:1px solid var(--line);border-radius:6px;padding:1px 6px;color:var(--dim);font-size:11px}
.grp-err{border-color:color-mix(in srgb,var(--err) 30%,var(--line))}
.grp-err-banner{margin:12px 18px 0}
.grp-body{padding:16px 18px}
.grp-body .airport{margin-bottom:14px}
.grp-body .airport:last-child{margin-bottom:0}
.btn.spinning svg{animation:spin 1.2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.spin-text{margin-left:2px}

.meter{height:7px;border-radius:99px;background:var(--surface-3);overflow:hidden;display:flex}
.meter i{display:block;height:100%;width:var(--p,0%);transition:width .5s cubic-bezier(.4,0,.2,1)}
.meter .m-dl{background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.meter .m-ul{background:color-mix(in srgb,var(--accent) 45%,var(--surface-3))}
.meter.warn .m-dl{background:linear-gradient(90deg,var(--warn),#e08a3c)}
.meter.err .m-dl{background:linear-gradient(90deg,var(--err),#d63b40)}

pre.debug{
  background:var(--bg);border:1px solid var(--line);border-radius:var(--r);
  padding:12px;overflow:auto;max-height:460px;white-space:pre-wrap;word-break:break-all;
  color:var(--dim);margin:10px 0 0;
}
ul.files{list-style:none;padding:0;margin:0}
ul.files li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:13px;align-items:center}
ul.files li:last-child{border-bottom:0}
ul.files a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ============================================================
   配置页
   ============================================================ */
.toolbar{
  position:sticky;top:var(--head-h);z-index:30;
  display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  background:var(--surface-2);
  -webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);
  border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;margin-bottom:18px;
  box-shadow:var(--shadow);
}
.toolbar .spacer{flex:1}
.dirty{
  display:none;align-items:center;gap:6px;font-size:12px;color:var(--warn);
  background:color-mix(in srgb,var(--warn) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);
  border-radius:999px;padding:3px 10px;
}
.dirty.on{display:inline-flex}

.ap{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow);overflow:hidden}
.ap + .ap{margin-top:12px}
.ap-head{display:flex;align-items:center;gap:10px;padding:13px 16px;background:linear-gradient(180deg,var(--surface-3),transparent);border-bottom:1px solid var(--line-soft)}
.ap-head strong{font-size:14.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-body{padding:16px}
.pd{border:1px solid var(--line);border-radius:var(--r);padding:13px;background:var(--surface-2)}
.pd + .pd{margin-top:10px}
.pd-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.pd-h strong{font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.subrow{display:grid;grid-template-columns:minmax(96px,.7fr) 2fr auto;gap:8px;align-items:center;margin-top:8px}

/* ============================================================
   登录页
   ============================================================ */
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.login{
  width:100%;max-width:376px;background:var(--surface);border:1px solid var(--line);
  border-radius:20px;padding:30px 28px;box-shadow:var(--shadow);
}
.login-brand{display:flex;align-items:center;gap:11px;margin-bottom:6px}
.login-brand .brand-mark{width:38px;height:38px;border-radius:12px}
.login-title{font-size:18px;font-weight:680;letter-spacing:-.02em;line-height:1.25}
.pw-actions{margin-top:6px;display:flex;gap:8px}
.pw-reveal{margin-top:8px}
.pw-reveal code{font-size:14px;letter-spacing:.06em;padding:6px 12px;user-select:all;display:inline-block}
.setup-hint{margin-top:16px;font-size:11.5px;color:var(--muted);line-height:1.6}
.login-sub{font-size:12.5px;color:var(--muted);margin-bottom:22px}
.login .btn{width:100%;padding:10px;font-size:14px;margin-top:16px;border-radius:11px}

/* ============================================================
   Toast
   ============================================================ */
#toasts{position:fixed;right:18px;bottom:18px;z-index:90;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{
  pointer-events:auto;min-width:220px;max-width:min(90vw,380px);
  background:var(--surface-solid);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:var(--r);padding:11px 14px;font-size:13px;box-shadow:0 18px 40px -20px rgba(0,0,0,.95);
  animation:toast-in .22s cubic-bezier(.2,.8,.3,1);
}
.toast.ok{border-left-color:var(--ok)}
.toast.err{border-left-color:var(--err)}
.toast.warn{border-left-color:var(--warn)}
.toast.out{animation:toast-out .18s ease forwards}
@keyframes toast-in{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
@keyframes toast-out{to{opacity:0;transform:translateY(6px) scale(.97)}}

.hidden{display:none !important}
.mb16{margin-bottom:16px}
.skeleton[data-h]{height:58px}
.skeleton[data-h="34"]{height:34px}
.spacer{flex:1}
.skeleton{
  background:linear-gradient(90deg,var(--surface-3) 25%,var(--line-soft) 37%,var(--surface-3) 63%);
  background-size:400% 100%;animation:shimmer 1.3s ease infinite;border-radius:8px;
}
@keyframes shimmer{from{background-position:100% 0}to{background-position:0 0}}

/* ============================================================
   响应式
   ============================================================ */
@media (max-width:900px){
  .subgrid{grid-template-columns:1fr}
  .grid2{grid-template-columns:1fr}
  .subrow{grid-template-columns:1fr;gap:6px}
  .subrow .btn{justify-self:start}
}
@media (max-width:720px){
  .topbar-in{padding:0 12px;gap:6px}
  .brand-sub{display:none}
  .brand-name{font-size:13.5px}
  .brand{margin-right:0;gap:8px}
  .tabs{margin-left:2px;padding:2px}
  .tab{padding:6px 9px;font-size:12px}
  .shell{padding:18px 14px 60px}
  .toolbar{top:var(--head-h);padding:9px 10px}
  .toolbar .btn{flex:1 1 auto}
  .stat-value{font-size:22px}
  /* 提示文字独占一行，不再被 flex 拉成整宽色块 */
  .section-head{gap:4px}
  .section-head .hint-text{flex:1 0 100%;order:3}
  .section-head .spacer{display:none}
  .login{padding:26px 20px}
  #toasts{left:14px;right:14px;bottom:14px}
  .toast{max-width:none}
}
/* 窄屏（如 360px 手机）优先保住操作区，品牌名让位 */
@media (max-width:430px){
  .brand-name{display:none}
  .topbar-actions .btn{padding:6px 10px;font-size:12px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
@media print{.topbar,.toolbar,#toasts{display:none}}
`;

/* ---- 仪表盘脚本 ---- */
const APP_JS = `
'use strict';
function el(id){return document.getElementById(id);}

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

function fmtBytes(n){
  if(n===null||n===undefined||isNaN(n))return '—';
  var u=['B','KB','MB','GB','TB','PB'],i=0,v=Number(n);
  while(v>=1024&&i<u.length-1){v/=1024;i++;}
  return v.toFixed(i===0?0:1)+' '+u[i];
}
function relTime(iso){
  if(!iso) return '从未';
  var t=new Date(iso).getTime(); if(isNaN(t)) return '—';
  var s=Math.round((Date.now()-t)/1000);
  if(s<10) return '刚刚';
  if(s<60) return s+' 秒前';
  var m=Math.round(s/60); if(m<60) return m+' 分钟前';
  var h=Math.round(m/60); if(h<24) return h+' 小时前';
  var d=Math.round(h/24); if(d<30) return d+' 天前';
  return new Date(iso).toLocaleString('zh-CN',{hour12:false});
}

function toast(msg,kind){
  var box=el('toasts'); if(!box) return;
  var t=document.createElement('div');
  t.className='toast '+(kind||'');
  t.textContent=msg;
  box.appendChild(t);
  setTimeout(function(){ t.classList.add('out'); setTimeout(function(){ t.remove(); },220); }, kind==='err'?6000:2600);
}

var ICON={
  refresh:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  copy:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  check:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  key:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3"/><path d="m17 6 2.5 2.5"/><path d="m14.5 8.5 2.5 2.5"/></svg>',
  external:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>'
};

/* ---- 流量条（套餐级） ---- */
function meter(traffic){
  var t=traffic||{};
  var used=(Number(t.upload)||0)+(Number(t.download)||0);
  var total=Number(t.total)||0;
  var pct=total>0?Math.min(100,used/total*100):0;
  var cls=pct>=90?'err':(pct>=75?'warn':'');
  return '<div class="traffic-num">'+fmtBytes(used)+' <span>/ '+fmtBytes(total)+'</span></div>'+
    '<div class="meter '+cls+'"><i data-pct="'+pct+'"></i></div>'+
    '<div class="hint">'+(total>0?pct.toFixed(1)+'% 已用 · 剩余 '+fmtBytes(Math.max(0,total-used)):'流量上限未知')+'</div>';
}

/* ---- 套餐卡（流量/到期归属套餐，不在每条订阅里重复） ---- */
function productCard(p){
  var bad=!!p.lastError;
  var dot= p.refreshing?'busy':(bad?'err':(p.trafficUpdatedAt?'ok':'warn'));
  var h='';
  h+='<section class="airport'+(bad?' sub-err':'')+'">';
  h+='<div class="airport-head"><span class="dot '+dot+'"></span>';
  h+='<h3>'+esc(p.name)+'</h3>';
  h+='<div class="airport-meta">';
  if(p.expire) h+='<span class="badge idle">到期 '+esc(p.expire)+'</span>';
  h+='<span class="badge idle">套餐 ID '+esc(p.serviceId)+'</span>';
  h+='<span>'+p.subs.length+' 条订阅</span>';
  h+='</div>';
  h+='<button class="btn ghost sm" data-prefresh="'+esc(p.id)+'" type="button"'+(p.refreshing?' disabled':'')+'>'+(p.refreshing?'刷新中…':'刷新')+'</button>';
  h+='</div>';
  h+='<div class="airport-body">';

  if(bad){ h+='<div class="banner err mb16">'+esc(p.lastError)+'</div>'; }

  h+='<div class="plan-traffic">'+meter(p.traffic)+
     '<div class="hint muted">流量更新于 '+relTime(p.trafficUpdatedAt)+'</div></div>';

  if(!p.subs.length){
    h+='<div class="empty">这个套餐下没有解析到订阅链接。</div>';
  }else{
    h+='<div class="sub-list">';
    p.subs.forEach(function(s){
      // 未设 PUBLIC_URL 时服务端只回路径 —— 按浏览器地址栏补全，
      // 复制出来的值与打开管理页用的地址严格一致；设了则是完整地址，原样用
      var full= s.subUrl.indexOf('http')===0 ? s.subUrl : location.origin+s.subUrl;
      h+='<div class="sub-line">';
      h+='<span class="sub-name">'+esc(s.name)+'</span>';
      h+='<div class="sub-url"><code title="'+esc(full)+'">'+esc(full)+'</code>';
      h+='<button class="btn ghost sm" data-copy="'+esc(full)+'" type="button" title="复制订阅地址（给客户端用）">'+ICON.copy+'</button>';
      if(s.url) h+='<button class="btn ghost sm" data-copy="'+esc(s.url)+'" type="button" title="复制真实订阅地址（机场返回的原始地址）">'+ICON.external+'</button>';
      h+='<button class="btn ghost sm" data-regen="'+esc(s.key)+'" type="button" title="旧地址立即失效，只有这一条受影响">'+ICON.key+'</button>';
      h+='</div></div>';
    });
    h+='</div>';
  }
  h+='</div></section>';
  return h;
}

function renderStats(s){
  var plans=s.products||[];
  var subTotal=0, okPlans=0, badPlans=0, dl=0, tot=0;
  plans.forEach(function(p){
    subTotal+=p.subs.length;
    if(p.lastError) badPlans++;
    else if(p.trafficUpdatedAt) okPlans++;
    var t=p.traffic||{};
    dl+=(Number(t.download)||0)+(Number(t.upload)||0);
    tot+=Number(t.total)||0;
  });

  el('stats').innerHTML=
    tile('套餐', plans.length, subTotal+' 条订阅','stat')+
    tile('正常', okPlans, plans.length?('共 '+plans.length+' 个'):'—','stat '+(okPlans?'ok':''))+
    tile('异常', badPlans, badPlans?'需要关注':'无报错','stat '+(badPlans?'err':'ok'))+
    tile('已用流量', fmtBytes(dl), tot>0?('总 '+fmtBytes(tot)+' · '+Math.round(dl/tot*100)+'%'):'总量未知','stat');
}

function tile(label,value,foot,cls){
  return '<div class="'+(cls||'stat')+'"><div class="stat-label">'+esc(label)+'</div>'+
    '<div class="stat-value">'+esc(value)+'</div>'+
    '<div class="stat-foot">'+esc(foot)+'</div></div>';
}

function render(s){
  renderStats(s);

  var accounts=s.accounts||[];
  var warns=[];
  if(!accounts.length) warns.push('尚未配置机场账号：请到「设置」页填写机场地址、邮箱和密码，保存后会自动开始抓取。');
  accounts.forEach(function(a){ if(a.lastError) warns.push('账号 '+esc(a.name)+'：'+esc(a.lastError)); });
  var box=el('warnBox');
  if(!warns.length){ box.classList.add('hidden'); box.innerHTML=''; }
  else{ box.classList.remove('hidden'); box.innerHTML='<div class="banner-body"><strong>需要处理</strong><ul>'+warns.map(function(t){return '<li>'+t+'</li>';}).join('')+'</ul></div>'; }

  var plans=s.products||[];
  if(!plans.length && !accounts.length){
    el('groups').innerHTML='<div class="empty"><strong>还没有配置机场账号</strong>到「设置」页填写机场地址、邮箱和密码并保存 —— 保存后会自动转到这里开始抓取。</div>';
  }else if(!plans.length){
    el('groups').innerHTML='<div class="empty"><strong>还没有抓取到套餐</strong>点右上角「刷新全部」，程序会登录各账号并抓取套餐与订阅链接。</div>';
  }else{
    el('groups').innerHTML=renderGroups(s);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-pct]'),function(b){
    b.style.setProperty('--p',(parseFloat(b.getAttribute('data-pct'))||0)+'%');
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'),function(b){
    b.addEventListener('click',function(){ copyText(b.getAttribute('data-copy'),b); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-regen]'),function(b){
    b.addEventListener('click',function(){ regenSubToken(b.getAttribute('data-regen'),b); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-prefresh]'),function(b){
    b.addEventListener('click',function(){ doRefresh(b.getAttribute('data-prefresh'),b); });
  });
}

/** 按账号分组：同一账号下的所有套餐视觉上归到一起 */
function renderGroups(s){
  var plans=s.products||[];
  var accs=s.accounts||[];
  var byAcc={};
  plans.forEach(function(p){
    var k=p.accountId||'';
    (byAcc[k]=byAcc[k]||[]).push(p);
  });

  // 分组顺序跟账号配置顺序一致；有套餐但账号已删的挂到「未知账号」
  var order=accs.map(function(a){return a.id;});
  Object.keys(byAcc).forEach(function(k){ if(order.indexOf(k)<0) order.push(k); });

  return order.map(function(accId){
    var acc=null;
    accs.forEach(function(a){ if(a.id===accId) acc=a; });
    var list=byAcc[accId]||[];
    var name= acc? (acc.name||'花云') : '未知账号';
    var bad= acc? !!acc.lastError : list.some(function(p){return p.lastError;});
    var busy= list.some(function(p){return p.refreshing;});
    var dot= busy?'busy':(bad?'err':'ok');

    var h='<section class="account-group'+(bad?' grp-err':'')+'">';
    h+='<div class="grp-head"><span class="dot '+dot+'"></span>';
    h+='<h3 class="grp-name">'+esc(name)+'</h3>';
    if(acc) h+='<code class="grp-url">'+esc(acc.baseUrl)+'</code>';
    h+='<span class="badge idle">'+list.length+' 个套餐 · '+
       list.reduce(function(n,p){return n+p.subs.length;},0)+' 条订阅</span>';
    h+='</div>';
    if(acc && acc.lastError) h+='<div class="banner err grp-err-banner">'+esc(acc.lastError)+'</div>';
    h+='<div class="grp-body">'+ list.map(productCard).join('') +'</div>';
    h+='</section>';
    return h;
  }).join('');
}

function copyText(v,btn){
  var done=function(){
    if(btn){
      var old=btn.innerHTML;
      btn.innerHTML=ICON.check;
      setTimeout(function(){ btn.innerHTML=old; },1400);
    }
    toast('已复制到剪贴板','ok');
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(done,function(){ fallbackCopy(v,done); });
  }else fallbackCopy(v,done);
}
function fallbackCopy(v,done){
  var ta=document.createElement('textarea');
  ta.value=v; ta.setAttribute('readonly','');
  // 不能用 display:none —— execCommand('copy') 对不可见元素选不中内容，
  // 会静默复制空串（非 HTTPS 访问时浏览器没有 navigator.clipboard，走这里）
  ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0';
  ta.contentEditable=true;
  document.body.appendChild(ta); ta.focus(); ta.select();
  var ok=false;
  try{ ok=document.execCommand('copy'); }catch(e){}
  ta.remove();
  if(ok) done(); else toast('复制失败，请手动选择地址复制','warn');
}

/** 轮换单条订阅的 Token */
async function regenSubToken(key,btn){
  if(!confirm('重新生成这条订阅的地址？旧地址会立即失效，只有这一条订阅受影响；记得更新客户端里的订阅地址。')) return;
  if(btn) btn.disabled=true;
  try{
    var r=await fetch('/api/config/token',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'}, body:JSON.stringify({key:key})});
    var j=await r.json().catch(function(){ return {error:'响应异常'}; });
    if(!r.ok||!j.ok){ toast('生成失败：'+(j.error||r.status),'err'); }
    else{ toast('已生成新地址，请更新客户端里的订阅地址','ok'); }
    await load(true);
  }catch(e){ toast('生成失败：'+e,'err'); }
  if(btn) btn.disabled=false;
}

async function load(silent){
  try{
    var r=await fetch('/api/status',{credentials:'same-origin'});
    if(r.status===401){ location.href='/login'; return; }
    render(await r.json());
  }catch(e){
    toast('状态加载失败：'+e,'err');
  }
}

/** 刷新单个套餐的流量（快，不登录，直接回源） */
async function doRefresh(productId,btn){
  if(btn){ btn.disabled=true; btn.dataset.label=btn.innerHTML; btn.textContent='刷新中…'; }
  try{
    var r=await fetch('/refresh',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'}, body:JSON.stringify({productId:productId})});
    var j=await r.json().catch(function(){ return {error:'响应异常'}; });
    if(!r.ok||!j.ok){ toast('刷新失败：'+(j.error||r.status),'err'); }
    else{ toast('流量已更新','ok'); }
    await load(true);
  }catch(e){ toast('刷新失败：'+e,'err'); }
  if(btn){ btn.disabled=false; btn.innerHTML=btn.dataset.label; }
}

/**
 * 刷新全部：按账号逐个调接口，按钮上实时显示「第 n/共 N 个：账号名」，
 * 每完成一个账号就刷新一次页面数据 —— 看得到进度，不会像卡住一样。
 * onlyIds 传入账号 id 数组时只刷这些账号（设置页保存新增账号后跳转过来用）。
 */
async function doRefreshAll(onlyIds){
  var st=await fetch('/api/status',{credentials:'same-origin'}).then(function(r){return r.json()}).catch(function(){return null});
  if(!st){ toast('状态加载失败','err'); return; }
  var accs=st.accounts||[];
  if(onlyIds && onlyIds.length){
    var wanted=onlyIds;
    accs=accs.filter(function(a){ return wanted.indexOf(a.id)>=0; });
  }
  if(!accs.length){
    if(!onlyIds) toast('尚未配置机场账号，请先到「设置」页填写并保存','warn');
    return;
  }

  var all=el('btnRefresh');
  all.disabled=true;
  all.classList.add('spinning');
  var failed=[];

  for(var i=0;i<accs.length;i++){
    var a=accs[i];
    all.innerHTML=ICON.refresh+'<span class="spin-text">刷新中 '+(i+1)+'/'+accs.length+'：'+esc(a.name||'花云')+'…</span>';
    // 每完成一个账号就刷一次页面，套餐卡上的转圈状态肉眼可见
    try{
      var r=await fetch('/refresh',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'}, body:JSON.stringify({accountId:a.id})});
      var j=await r.json().catch(function(){ return {error:'响应异常'}; });
      if(!r.ok||!j.ok){ failed.push((a.name||'花云')+'：'+(j.error||r.status)); }
    }catch(e){ failed.push((a.name||'花云')+'：'+e); }
    await load(true);
  }

  all.disabled=false;
  all.classList.remove('spinning');
  all.innerHTML=ICON.refresh+'刷新全部';

  if(!failed.length) toast('全部刷新完成','ok');
  else if(failed.length<accs.length) toast('完成，但 '+failed.length+' 个账号失败','warn');
  else toast('刷新失败：'+failed[0],'err');
}

function boot(){
  el('btnRefresh').addEventListener('click',function(){ doRefreshAll(); });
  el('btnLogout').addEventListener('click',async function(){
    await fetch('/logout',{method:'POST',credentials:'same-origin'});
    location.href='/login';
  });
  load();

  // 设置页保存新增账号后跳转过来：/?refresh=<id,id,...> 自动抓取这些账号，
  // ?refresh=all 则刷全部。立即清掉参数，避免用户手动刷新页面时重复触发。
  var m=/[?&]refresh=([^&]*)/.exec(location.search);
  if(m){
    var val=decodeURIComponent(m[1]);
    history.replaceState(null,'',location.pathname);
    doRefreshAll(val==='all'? null : val.split(',').filter(Boolean));
  }
}
document.addEventListener('DOMContentLoaded',boot);
`;

/* ---- 首次设置页脚本（随机口令生成） ---- */
const SETUP_JS = `
'use strict';
(function(){
  var btn=document.getElementById('btnGenPw');
  if(!btn) return;
  btn.addEventListener('click',function(){
    var digits='23456789',upper='ABCDEFGHJKLMNPQRSTUVWXYZ',lower='abcdefghijkmnpqrstuvwxyz';
    var all=digits+upper+lower;
    var out=[
      digits[Math.floor(Math.random()*digits.length)],
      upper[Math.floor(Math.random()*upper.length)],
      lower[Math.floor(Math.random()*lower.length)]
    ];
    while(out.length<12) out.push(all[Math.floor(Math.random()*all.length)]);
    for(var i=out.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=out[i];out[i]=out[j];out[j]=t;}
    var pw=out.join('');
    document.getElementById('p').value=pw;
    var r=document.getElementById('pwReveal');
    r.classList.remove('hidden');
    r.querySelector('code').textContent=pw;
  });
})();
`;

/* ---- 配置页脚本 ---- */
const CONFIG_JS = `
'use strict';
function el(id){return document.getElementById(id);}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function toast(msg,kind){
  var box=el('toasts'); if(!box) return;
  var t=document.createElement('div');
  t.className='toast '+(kind||''); t.textContent=msg;
  box.appendChild(t);
  setTimeout(function(){ t.classList.add('out'); setTimeout(function(){ t.remove(); },220); }, kind==='err'?6000:2600);
}
function busy(btn,on,text){
  if(!btn) return;
  if(on){ btn.dataset.label=btn.textContent; btn.disabled=true; btn.textContent=text||'处理中…'; }
  else { btn.disabled=false; if(btn.dataset.label) btn.textContent=btn.dataset.label; }
}

var accounts=[];   // {id?, name, baseUrl, email, password, hasPassword}
var dirty=false;

function setDirty(on){
  dirty=on;
  var d=el('dirtyFlag'); if(d) d.classList.toggle('on',on);
  var b=el('btnSave'); if(b) b.textContent=on?'保存更改':'保存';
}

/** 渲染账号卡片列表（本地状态驱动，保存时一次性提交） */
function render(){
  if(!accounts.length){
    el('accounts').innerHTML='<div class="empty"><strong>还没有机场账号</strong>点「+ 添加机场账号」开始。机场名可不填（默认「花云」），地址保持默认即可。</div>';
    return;
  }
  el('accounts').innerHTML=accounts.map(function(a,i){
    return '<section class="ap">'+
      '<div class="ap-head"><span class="dot '+(a.lastError?'err':'ok')+'"></span>'+
      '<strong>'+esc(a.name||'花云')+'</strong>'+
      '<span class="badge idle">'+esc(a.email||'未填邮箱')+'</span>'+
      '<button class="btn danger sm" data-del="'+i+'" type="button">删除</button></div>'+
      '<div class="ap-body stack">'+
      (a.lastError?'<div class="banner err sm">'+esc(a.lastError)+'</div>':'')+
      '<div class="grid2">'+
        '<div><label>机场名</label><input data-i="'+i+'" data-f="name" value="'+esc(a.name)+'" placeholder="花云"></div>'+
        '<div><label>机场地址</label><input data-i="'+i+'" data-f="baseUrl" value="'+esc(a.baseUrl)+'" placeholder="https://api-flowercloud.com" spellcheck="false"></div>'+
        '<div><label>邮箱</label><input data-i="'+i+'" data-f="email" type="email" value="'+esc(a.email)+'" autocomplete="username" spellcheck="false"></div>'+
        '<div><label>密码</label><input data-i="'+i+'" data-f="password" type="password" '+(a.hasPassword?'placeholder="已设置，留空表示不修改"':'placeholder="请输入密码"')+' autocomplete="new-password"></div>'+
      '</div></div></section>';
  }).join('');

  el('accounts').querySelectorAll('input').forEach(function(inp){
    inp.addEventListener('input',function(){
      var i=+inp.getAttribute('data-i'), f=inp.getAttribute('data-f');
      accounts[i][f]=inp.value;
      setDirty(true);
      // 机场名 / 邮箱实时同步到标题
      if(f==='name'||f==='email'){
        var head=el('accounts').querySelectorAll('.ap-head strong')[i];
        if(head) head.textContent=accounts[i].name||'花云';
      }
    });
  });
  el('accounts').querySelectorAll('[data-del]').forEach(function(b){
    b.addEventListener('click',function(){
      var i=+b.getAttribute('data-del');
      var a=accounts[i];
      if(!confirm('删除账号「'+(a.name||'花云')+'」（'+(a.email||'未填邮箱')+'）？其名下的套餐与订阅地址会一并删除。')) return;
      accounts.splice(i,1); setDirty(true); render();
    });
  });
}

async function load(){
  try{
    var r=await fetch('/api/config',{credentials:'same-origin'});
    if(r.status===401){ location.href='/login'; return; }
    var j=await r.json();
    accounts=(j.accounts||[]).map(function(a){
      return {id:a.id,name:a.name,baseUrl:a.baseUrl,email:a.email,password:'',hasPassword:a.hasPassword};
    });
    render();
    setDirty(false);
  }catch(e){ toast('加载失败：'+e,'err'); }
}

function collect(){
  return accounts.map(function(a){
    return { id:a.id||'', name:a.name, baseUrl:a.baseUrl, email:a.email, password:a.password };
  });
}

async function save(){
  var btn=el('btnSave');
  // 空密码的已存在账号由后端保持原值；全新账号必须有密码
  var newEmails=[];
  var keySeen={};
  for(var i=0;i<accounts.length;i++){
    var a=accounts[i];
    if(!a.id) newEmails.push(a.email);
    if(!a.hasPassword && !a.password){ toast('账号「'+(a.name||'花云')+'」还没有填密码','warn'); return; }
    // 同一个登录（地址+邮箱）只允许出现一次：后端会把两条当成同一账号，
    // 报错也很难看懂，这里直接拦下并说清楚
    var key=(a.baseUrl||'').trim().toLowerCase()+'|'+(a.email||'').trim().toLowerCase();
    if(keySeen[key]!==undefined){
      var other=accounts[keySeen[key]];
      toast('账号「'+(a.name||'花云')+'」与「'+(other.name||'花云')+'」的机场地址和邮箱完全相同，是同一个登录，不能重复添加；如需改名请直接修改原账号','err');
      return;
    }
    keySeen[key]=i;
  }
  busy(btn,true,'保存中…');
  try{
    var r=await fetch('/api/config',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'}, body:JSON.stringify({accounts:collect()})});
    var j=await r.json().catch(function(){ return {error:'响应异常'}; });
    if(!r.ok||!j.ok){ toast('保存失败：'+(j.error||r.status),'err'); }
    else if(newEmails.length){
      // 新增了账号：直接跳仪表盘并自动抓取这些账号（服务端刚生成 id，按邮箱对上）
      var st=await fetch('/api/status',{credentials:'same-origin'}).then(function(x){return x.json()}).catch(function(){return null});
      var ids=[];
      if(st) (st.accounts||[]).forEach(function(sa){
        if(newEmails.indexOf(sa.email)>=0 && ids.indexOf(sa.id)<0) ids.push(sa.id);
      });
      toast('已保存，正在登录并抓取套餐…','ok');
      // 保存已成功，先解除 beforeunload 离开守卫，否则程序化跳转会弹「离开此网站？」
      setDirty(false);
      location.href='/dashboard?refresh='+(ids.length? encodeURIComponent(ids.join(',')) : 'all');
      return;
    }
    else{ toast('已保存','ok'); await load(); }
  }catch(e){ toast('保存失败：'+e,'err'); }
  busy(btn,false);
}

async function doImport(file){
  if(!file) return;
  if(!confirm('导入将覆盖当前全部配置（含账号与套餐），确定继续？')) return;
  try{
    var text=await file.text();
    var r=await fetch('/api/config/import',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'text/plain'}, body:text});
    var j=await r.json().catch(function(){ return {error:'响应异常'}; });
    if(!r.ok||!j.ok){ toast('导入失败：'+(j.error||r.status),'err'); }
    else{ toast('导入成功','ok'); await load(); }
  }catch(e){ toast('导入失败：'+e,'err'); }
}

function boot(){
  el('btnSave').addEventListener('click',save);
  el('btnAdd').addEventListener('click',function(){
    accounts.push({name:'',baseUrl:'https://api-flowercloud.com',email:'',password:'',hasPassword:false});
    setDirty(true); render();
    var inputs=el('accounts').querySelectorAll('input');
    if(inputs.length) inputs[0].focus();
  });
  el('btnExport').addEventListener('click',function(){
    window.location.href='/api/config/export';
    toast('正在下载配置文件','ok');
  });
  el('btnImportTrigger').addEventListener('click',function(){ el('importFile').click(); });
  el('importFile').addEventListener('change',function(ev){
    doImport(ev.target.files[0]); ev.target.value='';
  });
  // 管理口令：随机生成 + 修改
  el('btnGenPw').addEventListener('click',function(){
    var digits='23456789',upper='ABCDEFGHJKLMNPQRSTUVWXYZ',lower='abcdefghijkmnpqrstuvwxyz';
    var all=digits+upper+lower;
    var out=[
      digits[Math.floor(Math.random()*digits.length)],
      upper[Math.floor(Math.random()*upper.length)],
      lower[Math.floor(Math.random()*lower.length)]
    ];
    while(out.length<12) out.push(all[Math.floor(Math.random()*all.length)]);
    for(var i=out.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=out[i];out[i]=out[j];out[j]=t;}
    el('newPw').value=out.join('');
    setDirty(true);
    toast('已生成随机口令，点「修改口令」生效','ok');
  });
  el('btnChangePw').addEventListener('click',async function(){
    var pw=el('newPw').value;
    var btn=el('btnChangePw'); btn.disabled=true;
    try{
      var r=await fetch('/api/admin-password',{method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'}, body:JSON.stringify({password:pw})});
      var j=await r.json().catch(function(){ return {error:'响应异常'}; });
      if(!r.ok||!j.ok){ toast('修改失败：'+(j.error||r.status),'err'); }
      else{ toast('口令已修改，下次登录生效','ok'); el('newPw').value=''; }
    }catch(e){ toast('修改失败：'+e,'err'); }
    btn.disabled=false;
  });
  el('btnLogout').addEventListener('click',async function(){
    if(dirty && !confirm('有未保存的修改，确定离开？')) return;
    // 已确认离开（或本来没有修改），解除守卫，避免跳转时再弹一次原生确认框
    setDirty(false);
    await fetch('/logout',{method:'POST',credentials:'same-origin'});
    location.href='/login';
  });

  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){ e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload',function(e){
    if(!dirty) return;
    e.preventDefault(); e.returnValue='';
  });

  load();
}
document.addEventListener('DOMContentLoaded',boot);
`;

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

function page(title, body) {
  // 内联 SVG data URI 做 favicon，省掉一次 404；CSP img-src 允许 data:
  const favicon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%235b8cff'/%3E%3Cpath d='M10 22V10h9M10 16h7' stroke='white' stroke-width='2.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark light">
<title>${title}</title><link rel="icon" href="${favicon}"><link rel="stylesheet" href="/assets/style.css"></head>
<body>${body}<div id="toasts"></div></body></html>`;
}

const LOGO = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M5 19V5h10"/><path d="M5 12h8"/></svg>`;

const HEADER = (active) => `
<div class="topbar"><div class="topbar-in">
  <div class="brand">
    <span class="brand-mark">${LOGO}</span>
    <span class="brand-text">
      <span class="brand-name">FlowerCloud 订阅助手</span>
      <span class="brand-sub">自动抓取套餐与订阅地址</span>
    </span>
  </div>
  <nav class="tabs">
    <a class="tab${active === 'dash' ? ' active' : ''}" href="/dashboard">仪表盘</a>
    <a class="tab${active === 'config' ? ' active' : ''}" href="/config">设置</a>
  </nav>
  <div class="topbar-actions">
    <button id="btnLogout" class="btn ghost sm" type="button">退出登录</button>
  </div>
</div></div>`;

/** 首次访问（口令未设置）：用户自主设置口令，可一键随机生成 */
function setupPage(message) {
  return page(
    '首次设置 · FlowerCloud 订阅助手',
    `<div class="login-wrap"><div class="login">
  <div class="login-brand">
    <span class="brand-mark">${LOGO}</span>
    <span class="login-title">FlowerCloud 订阅助手</span>
  </div>
  <p class="login-sub">设置管理口令以继续。要求：至少 8 位，包含数字、大写字母和小写字母。</p>
  ${message ? `<div class="banner err mb16">${message}</div>` : ''}
  <form method="post" action="/login">
    <label for="p">管理口令</label>
    <input id="p" name="password" type="password" autocomplete="new-password" autofocus required minlength="8">
    <div class="pw-actions">
      <button type="button" class="btn ghost" id="btnGenPw">随机生成</button>
    </div>
    <div class="pw-reveal hidden" id="pwReveal"><code></code></div>
    <div class="spacer"></div>
    <button type="submit" class="btn">保存并登录</button>
  </form>
  <p class="setup-hint">口令保存在配置文件 <code>config.json</code> 的 <code>adminPassword</code> 字段，忘记时直接打开查看即可。</p>
</div></div>
<script src="/assets/setup.js"></script>`
  );
}

function loginPage(message) {
  return page(
    '登录 · FlowerCloud 订阅助手',
    `<div class="login-wrap"><div class="login">
  <div class="login-brand">
    <span class="brand-mark">${LOGO}</span>
    <span class="login-title">FlowerCloud 订阅助手</span>
  </div>
  <p class="login-sub">输入管理口令以继续。</p>
  ${message ? `<div class="banner err mb16">${message}</div>` : ''}
  <form method="post" action="/login">
    <label for="p">管理口令</label>
    <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit" class="btn">登录</button>
  </form>
  <p class="setup-hint">忘记口令？打开配置文件 <code>config.json</code> 查看 <code>adminPassword</code> 字段。</p>
</div></div>`
  );
}

function dashboardPage() {
  return page(
    '仪表盘 · FlowerCloud 订阅助手',
    `${HEADER('dash')}
<div class="shell">
  <div id="warnBox" class="banner warn hidden mb16"></div>

  <section class="section">
    <div class="section-head">
      <h2>总览</h2>
      <span class="hint-text">订阅内容实时回源、流量随回源同步；套餐结构在点「刷新全部」或订阅自愈时更新</span>
      <span class="spacer"></span>
      <button id="btnRefresh" class="btn" type="button">刷新全部</button>
    </div>
    <div id="stats" class="stats">
      <div class="stat"><div class="skeleton" data-h="58"></div></div>
      <div class="stat"><div class="skeleton" data-h="58"></div></div>
      <div class="stat"><div class="skeleton" data-h="58"></div></div>
      <div class="stat"><div class="skeleton" data-h="58"></div></div>
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <h2>套餐与订阅</h2>
      <span class="hint-text">把订阅地址填进代理客户端的订阅设置即可，流量与到期会自动显示</span>
    </div>
    <div id="groups"><div class="empty">加载中…</div></div>
  </section>
</div>
<script src="/assets/app.js"></script>`
  );
}

function configPage() {
  return page(
    '设置 · FlowerCloud 订阅助手',
    `${HEADER('config')}
<div class="shell">
  <div class="toolbar">
    <button id="btnSave" class="btn" type="button">保存</button>
    <span id="dirtyFlag" class="dirty"><span class="dot warn"></span>有未保存的修改</span>
    <span class="spacer"></span>
    <button id="btnAdd" class="btn ghost" type="button">+ 添加机场账号</button>
    <button id="btnExport" class="btn ghost" type="button">导出</button>
    <input id="importFile" type="file" accept="application/json,.json" class="hidden">
    <button id="btnImportTrigger" class="btn ghost" type="button">导入</button>
  </div>

  <section class="section">
    <div class="section-head">
      <h2>机场账号</h2>
      <span class="hint-text">保存后自动转到仪表盘并抓取套餐；也可随时回仪表盘点「刷新全部」</span>
    </div>
    <div id="accounts"><div class="empty">加载中…</div></div>
  </section>

  <section class="section">
    <div class="section-head">
      <h2>管理口令</h2>
      <span class="hint-text">至少 8 位，包含数字、大写字母和小写字母</span>
    </div>
    <div class="card">
      <div class="grid2">
        <div>
          <label for="newPw">新口令</label>
          <input id="newPw" type="password" autocomplete="new-password" placeholder="留空表示不修改">
          <div class="hint">修改后下次登录使用新口令，当前会话不受影响。口令保存在配置文件 <code>config.json</code> 的 <code>adminPassword</code> 字段，忘记时直接打开查看。</div>
        </div>
        <div>
          <label>&nbsp;</label>
          <div class="pw-actions">
            <button id="btnGenPw" class="btn ghost" type="button">随机生成</button>
            <button id="btnChangePw" class="btn" type="button">修改口令</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</div>
<script src="/assets/config.js"></script>`
  );
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export function registerAdminRoutes(app) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));
  router.use(securityHeaders);

  // 管理页始终启用：未设置口令时首次访问进入「首次设置」页，由用户自主设置
  router.get('/assets/style.css', (req, res) => res.type('text/css').send(STYLE));
  router.get('/assets/app.js', (req, res) => res.type('application/javascript').send(APP_JS));
  router.get('/assets/config.js', (req, res) => res.type('application/javascript').send(CONFIG_JS));
  router.get('/assets/setup.js', (req, res) => res.type('application/javascript').send(SETUP_JS));

  router.get('/login', (req, res) => {
    if (verifySession(req)) return res.redirect('/dashboard');
    res.type('html').send(adminConfigured() ? loginPage('') : setupPage(''));
  });

  router.post('/login', (req, res) => {
    const ip = clientIp(req);
    const rate = checkRate(ip);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter));
      return res
        .status(429)
        .type('html')
        .send(loginPage(`尝试过于频繁，请 ${rate.retryAfter} 秒后再试。`));
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    // 首次设置：口令未配置时，这个表单提交的就是新口令
    if (!adminConfigured()) {
      const err = validateAdminPassword(password);
      if (err) return res.status(400).type('html').send(setupPage(err));
      store.setAdminPassword(password);
      log('[admin] 首次设置：管理口令已创建（明文存于配置文件，便于本地找回）');
      attempts.delete(ip);
      const secure0 = isHttps(req);
      res.set(
        'Set-Cookie',
        [
          `${COOKIE_NAME}=${createSession()}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Strict',
          `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
          secure0 ? 'Secure' : '',
        ]
          .filter(Boolean)
          .join('; ')
      );
      return res.redirect('/dashboard');
    }

    if (!password || !currentAdminPassword() || !safeEqual(password, currentAdminPassword())) {
      recordFail(ip);
      log(`[admin] 登录失败 ip=${ip}`);
      return res.status(401).type('html').send(loginPage('口令错误。'));
    }

    attempts.delete(ip);
    const secure = isHttps(req);
    res.set(
      'Set-Cookie',
      [
        `${COOKIE_NAME}=${createSession()}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        secure ? 'Secure' : '',
      ]
        .filter(Boolean)
        .join('; ')
    );
    log(`[admin] 登录成功 ip=${ip}`);
    res.redirect('/dashboard');
  });

  router.post('/logout', (req, res) => {
    // 服务端同步注销：即使 Cookie 被复制走，也已无法通过校验
    const data = parseSessionCookie(req);
    if (data?.sid) {
      revokedSessions.set(data.sid, data.exp);
      log(`[admin] 会话已注销 sid=${data.sid}`);
    }
    res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/', (req, res) => res.redirect('/dashboard'));
  router.get('/dashboard', requireAuth, (req, res) => res.type('html').send(dashboardPage()));
  router.get('/config', requireAuth, (req, res) => res.type('html').send(configPage()));

  router.get('/api/status', requireAuth, (req, res) => {
    // 管理页要完整数据：订阅地址带 token、附机场原始地址
    res.json({ ...statusPayload({ tokens: true, realUrls: true }), https: isHttps(req) });
  });

  /* ---- 机场账号（仅管理会话；写操作校验同源） ---- */

  // 密码永远不回传，前端只拿到 hasPassword
  router.get('/api/config', requireAuth, (req, res) => {
    res.json({
      accounts: store.data.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        baseUrl: a.baseUrl,
        email: a.email,
        hasPassword: !!a.password,
      })),
      updatedAt: store.data.updatedAt,
    });
  });

  router.post('/api/config', requireAuth, sameOriginOnly, (req, res) => {
    try {
      const accounts = store.saveAccounts(req.body && req.body.accounts);
      log(`[admin] 机场账号已保存（${accounts.length} 个）`);
      res.json({ ok: true, accounts: accounts.length });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 修改管理口令（当前会话不受影响，下次登录用新口令）
  router.post('/api/admin-password', requireAuth, sameOriginOnly, (req, res) => {
    try {
      const pw = typeof req.body?.password === 'string' ? req.body.password : '';
      store.setAdminPassword(pw); // 内部先过强度校验，不达标直接抛
      log('[admin] 管理口令已修改');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 导入
  router.post(
    '/api/config/import',
    requireAuth,
    sameOriginOnly,
    express.text({ limit: '512kb', type: ['text/plain', 'application/json'] }),
    (req, res) => {
      try {
        const raw = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        store.replace(raw);
        log('[admin] 配置已导入');
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    }
  );

  router.get('/api/config/export', requireAuth, (req, res) => {
    const stamp = dateOnly();
    // 导出不含本机授权材料（管理口令 / 会话签名密钥）：否则导出的文件就是
    // 一份可直接登录、可伪造管理会话的完整凭据。导入时也不会用文件里的值覆盖本机。
    const { adminPassword, sessionSecret, ...safe } = store.data;
    res.set('Content-Disposition', `attachment; filename="flowercloud-config-${stamp}.json"`);
    res.type('application/json').send(JSON.stringify(safe, null, 2));
  });

  router.post('/api/config/token', requireAuth, sameOriginOnly, (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: '缺少订阅 key' });
    const token = store.regenerateSubToken(key);
    if (!token) return res.status(404).json({ ok: false, error: '未知订阅链接' });
    log(`[admin] 订阅 Token 已轮换 key=${key}`);
    res.json({ ok: true, key, token });
  });

  router.get('/api/debug', requireAuth, (req, res) => {
    try {
      if (!fs.existsSync(config.debugDir)) return res.json([]);
      const files = fs
        .readdirSync(config.debugDir)
        .filter((n) => /^[\w.-]+\.(html|txt)$/.test(n))
        .map((n) => {
          const st = fs.statSync(path.join(config.debugDir, n));
          return { name: n, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 50);
      res.json(files);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  router.get('/api/debug/:name', requireAuth, (req, res) => {
    const name = req.params.name;
    // 只允许安全的纯文件名，杜绝路径穿越
    if (!/^[\w.-]+\.(html|txt)$/.test(name) || name.includes('..')) {
      return res.status(400).type('text/plain').send('bad name');
    }
    const full = path.resolve(config.debugDir, name);
    const root = path.resolve(config.debugDir);
    if (!full.startsWith(root + path.sep)) {
      return res.status(400).type('text/plain').send('bad path');
    }
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_DEBUG_BYTES) {
        return res.status(413).type('text/plain').send('file too large');
      }
      res.type('text/plain').send(fs.readFileSync(full, 'utf8'));
    } catch {
      res.status(404).type('text/plain').send('not found');
    }
  });

  app.use('/', router);
  log('[admin] 管理页面已启用：/');
}
