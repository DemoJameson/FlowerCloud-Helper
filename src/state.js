/**
 * 刷新流程（多机场账号）
 *
 * 一次「刷新全部」按账号依次执行：
 *   1. FlareSolverr 登录该账号的花云面板（它负责过 Cloudflare）
 *   2. 抓客户中心列表页 → 解析套餐（ID / 名称 / 到期）
 *   3. 逐个套餐抓详情页 → 解析订阅链接，写回配置
 *   4. 每个套餐只拉**一条**订阅拿 subscription-userinfo ——
 *      同一套餐下所有订阅共用同一个上游 token，流量信息完全一样
 *
 * 订阅内容不做缓存：客户端每次来拉都实时回源，流量随回源同步写回
 * （syncTrafficFromSubFetch）；套餐结构在手动「刷新全部」或上游失效
 * 触发的 reauthorize 时更新。
 */
import { store, clientAreaUrl, productDetailsUrl } from './store.js';
import { config } from './config.js';
import * as fsp from './flaresolverr.js';
import { DEFAULT_SUBSCRIPTION_UA } from './fetchsub.js';
import { log, dateOnly } from './logtime.js';
import { parseProducts, parseSubscriptions, loginSucceeded, loginError, loginToken, loginFormAction } from './flowercloud.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 错误信息                                                             */
/* ------------------------------------------------------------------ */

/** 把原始报错翻译成用户能照着做的中文提示 */
export function describeError(e) {
  const msg = e?.message || String(e);
  if (/ECONNREFUSED|Failed to fetch|fetch failed/i.test(msg)) {
    return (
      '连不上 FlareSolverr：请确认它在运行（本服务应与它同在 compose 的一个网络里），' +
      '或检查 FLARESOLVERR_URL 配置。'
    );
  }
  if (/FlareSolverr:/i.test(msg)) return msg;
  if (/人机验证|Cloudflare/i.test(msg)) return `${msg}（FlareSolverr 已尝试放行仍未通过）`;
  return msg;
}

/* ------------------------------------------------------------------ */
/* 登录（单账号）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 登录一个机场账号，成功后 FlareSolverr 会话里就是该账号的登录态。
 *
 * ⚠️ 本服务只建一条 FlareSolverr 会话（见 flaresolverr.js），登录态是全局的，
 * 所以多账号必须串行「登出 → 登录 → 抓取」：客户中心页面无法分辨当前登录的是
 * 哪个账号 —— 直接访问时看到套餐列表可能是上一个账号的，若据此跳过登录，会把
 * A 的套餐抓到 B 头上。换账号时先访问 logout.php 清掉会话，再走完整登录。
 *
 * 串行由 withSessionLock 强制：FlareSolverr 本身支持多会话，这里锁定是因为
 * 共用一条会话；「刷新全部」与缓存失效触发的 reauthorize 可能并发，不加锁会串号。
 */
let lastLoginKey = null; // 'baseUrl|email'，记录 FlareSolverr 会话当前的登录身份

async function login(account) {
  const base = String(account.baseUrl || '').replace(/\/+$/, '');
  const key = base + '|' + account.email;
  const loginUrl = clientAreaUrl(account.baseUrl);

  // 上一个登录的不是本账号 → 先登出，保证从干净的登录页开始
  if (lastLoginKey && lastLoginKey !== key) {
    await fsp.get(base + '/logout.php').catch(() => {});
    lastLoginKey = null;
  }

  log(`[panel] ${account.name}：打开登录页 ${loginUrl}`);
  const page = await fsp.get(loginUrl);

  // 同一账号重复刷新：页面无密码框且有套餐列表 = 会话仍是本账号的
  if (loginSucceeded(page.html) && /action=productdetails/i.test(page.html)) {
    if (lastLoginKey === key) {
      log(`[panel] ${account.name}：会话仍有效，跳过登录`);
      return;
    }
    // 有登录态但不是本账号（且登出失败）—— 继续走登录流程覆盖
    log(`[panel] ${account.name}：检测到其它账号的登录态，强制重新登录`);
  }

  // 提交地址从页面表单里读：真实花云是 /dologin.php，不是 /clientarea.php
  const action = loginFormAction(page.html, account.baseUrl);
  const token = loginToken(page.html);
  // 配置里存的是密文，提交表单用解密后的明文
  const fields = { username: account.email, password: store.plainPassword(account) };
  if (token) fields.token = token;

  log(`[panel] ${account.name}：提交登录表单到 ${action}`);
  const res = await fsp.post(action, fields);

  if (!loginSucceeded(res.html)) {
    const tip = loginError(res.html);
    throw new Error(
      `登录失败：${tip || '密码框仍存在，可能账号密码不对'}` +
        `（提交地址 ${action}）`
    );
  }
  lastLoginKey = key;
  log(`[panel] ${account.name}：登录成功`);
}

/* ------------------------------------------------------------------ */
/* 抓取（单账号）                                                        */
/* ------------------------------------------------------------------ */

/* ---- 会话互斥：同一时刻只允许一个流程占用 FlareSolverr 会话 ----
 * 共用一条会话时，登录态是全局的；并发执行会串号（见 login 的说明）。
 * 用 Promise 链把所有「登录 + 抓取」串起来，排队执行。 */
let sessionQueue = Promise.resolve();
function withSessionLock(fn) {
  const run = sessionQueue.then(fn, fn);
  sessionQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** 抓一个账号的套餐与订阅结构（串行占用 FlareSolverr 会话） */
export function discoverAccount(account) {
  return withSessionLock(() => discoverAccountLocked(account));
}

async function discoverAccountLocked(account) {
  await login(account);
  const listPage = await fsp.get(clientAreaUrl(account.baseUrl));
  const products = parseProducts(listPage.html);

  if (!products.length) {
    throw new Error(
      `没能从 ${clientAreaUrl(account.baseUrl)} 解析出任何套餐。` +
        '请确认邮箱密码能登录，或该账号下确实有生效中的套餐。'
    );
  }
  log(`[discover] ${account.name}：${products.length} 个套餐`);

  const out = [];
  for (const p of products) {
    let subs = [];
    try {
      // 先打开订阅开关（V2raySocks 模块：不激活时上游 osubscribe.php 返回 404，
      // 转换站则报「doesn't contain any valid node info」）。重复激活是幂等的。
      await fsp.get(
        productDetailsUrl(account.baseUrl, p.id) +
          `&V2raySocksAction=ActivateSublink&Serviceid=${encodeURIComponent(p.id)}`
      ).catch((e) => log(`[discover]   ${p.name}(${p.id}) 激活订阅开关失败（继续尝试）：${describeError(e)}`));

      const page = await fsp.get(productDetailsUrl(account.baseUrl, p.id));
      subs = parseSubscriptions(page.html);
    } catch (e) {
      log(`[discover]   ${p.name}(${p.id}) 详情页抓取失败：${describeError(e)}`);
    }
    log(`[discover]   ${p.name} → ${subs.length} 条订阅`);
    out.push({ serviceId: p.id, name: p.name, expire: p.expire, subs });
    await sleep(400); // 少量间隔，别把机场打疼
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 流量（套餐级）                                                        */
/* ------------------------------------------------------------------ */

function parseUserInfo(header) {
  if (!header) return null;
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim()] = Number(v);
  }
  return Number.isFinite(out.total) ? out : null;
}

/** 拉一条订阅，只为了拿 subscription-userinfo（套餐流量） */
async function fetchTraffic(sub) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.SUB_TIMEOUT_MS || 60000));
  try {
    const res = await fetch(sub.url, {
      headers: {
        'user-agent': DEFAULT_SUBSCRIPTION_UA,
        accept: '*/*',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`订阅地址返回 HTTP ${res.status}`);
    await res.text(); // 必须读完，连接才能复用
    return parseUserInfo(res.headers.get('subscription-userinfo'));
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('拉取订阅超时', { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- /sub 实时回源顺带同步流量 ----
 * 回源响应里的 subscription-userinfo 就是该套餐的最新流量 —— 拿都拿到了，
 * 写回配置让仪表盘跟着客户端的拉取节奏走，不用等手动「刷新全部」。
 * 数值没变不写盘（只刷内存时间戳）；变了也至少间隔 60 秒再写，
 * 客户端轮询密集时不会频繁落盘磨损。 */
const TRAFFIC_SYNC_MIN_INTERVAL_MS = 60_000;

export function syncTrafficFromSubFetch(productId, userInfoHeader) {
  if (!userInfoHeader) return;
  const p = store.data.products.find((x) => x.id === productId);
  if (!p) return;
  const traffic = parseUserInfo(userInfoHeader);
  if (!traffic) return;

  const cur = p.traffic;
  const unchanged =
    cur &&
    cur.upload === traffic.upload &&
    cur.download === traffic.download &&
    cur.total === traffic.total &&
    cur.expire === traffic.expire;
  if (unchanged) {
    // 数值没变：只刷内存时间戳（仪表盘显示「刚刚拉取」），不为此写盘
    p.trafficUpdatedAt = Date.now();
    return;
  }
  if (Date.now() - (p.trafficUpdatedAt || 0) < TRAFFIC_SYNC_MIN_INTERVAL_MS) return;
  store.setProductTraffic(p.id, traffic);
}

function fmt(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

/* ------------------------------------------------------------------ */
/* 刷新全部                                                             */
/* ------------------------------------------------------------------ */

/** 套餐运行状态（内存）：refreshing 标记，不落盘 */
const runtime = new Map();

function rebuildRuntime() {
  for (const p of store.data.products) {
    if (!runtime.has(p.id)) runtime.set(p.id, { refreshing: false });
  }
  for (const id of [...runtime.keys()]) {
    if (!store.data.products.find((p) => p.id === id)) runtime.delete(id);
  }
}

/**
 * 刷新一个账号：登录 → 抓结构 → 每套餐拉一条订阅拿流量。
 * onlyProductId 传入时只更新该套餐的流量（跳过结构抓取，订阅地址在别的域名上，
 * 拉流量不需要登录面板）。
 */
export async function refreshAccount(account, { onlyProductId = null } = {}) {
  const r = { account: account.name, ok: false, error: '', products: 0 };

  // 只刷单个套餐的流量：直接回源，不登录
  if (onlyProductId) {
    const p = store.data.products.find((x) => x.id === onlyProductId && x.accountId === account.id);
    if (!p) throw new Error('未知套餐');
    const rt = runtime.get(p.id);
    if (rt) rt.refreshing = true;
    try {
      if (!p.subs.length) throw new Error('该套餐没有订阅链接');
      const traffic = await fetchTraffic(p.subs[0]);
      if (traffic) {
        store.setProductTraffic(p.id, traffic);
        r.ok = true;
        log(`[refresh]   ${p.name} 流量已更新`);
      } else {
        throw new Error('订阅未返回 subscription-userinfo');
      }
    } catch (e) {
      store.setProductError(p.id, describeError(e));
      throw e;
    } finally {
      if (rt) rt.refreshing = false;
    }
    return r;
  }

  // 完整刷新：登录 + 抓结构 + 全部套餐流量
  const discovered = await discoverAccount(account);
  const merged = store.saveDiscovered(account.id, discovered);
  rebuildRuntime();
  r.products = merged.length;
  store.setAccountError(account.id, '');

  for (const p of merged) {
    if (!p.subs.length) continue;
    const rt = runtime.get(p.id);
    if (rt) rt.refreshing = true;
    try {
      const traffic = await fetchTraffic(p.subs[0]);
      if (traffic) {
        store.setProductTraffic(p.id, traffic);
        log(
          `[refresh]   ${p.name} 流量 ${fmt(traffic.upload + traffic.download)} / ${fmt(traffic.total)}` +
            (traffic.expire ? `，到期 ${dateOnly(new Date(traffic.expire * 1000))}` : '')
        );
      } else {
        log(`[refresh]   ${p.name} 无流量信息（订阅未返回 subscription-userinfo）`);
      }
    } catch (e) {
      store.setProductError(p.id, describeError(e));
      log(`[refresh]   ${p.name} 流量获取失败: ${describeError(e)}`);
    } finally {
      if (rt) rt.refreshing = false;
    }
    await sleep(300);
  }
  r.ok = true;
  return r;
}

/**
 * 刷新全部账号（前端「刷新全部」按账号逐个调用，以便显示进度）。
 * 返回 { ok, okCount, total, results:[{account, ok, error, products}] }
 */
export async function refreshAll(reason = 'manual') {
  rebuildRuntime();
  const accounts = store.data.accounts;
  if (!accounts.length) {
    throw new Error('尚未配置机场账号。请先到「设置」页填写机场地址、邮箱和密码。');
  }
  log(`[refresh] 开始（${reason}），${accounts.length} 个账号`);

  const results = [];
  for (const account of accounts) {
    try {
      const r = await refreshAccount(account);
      results.push(r);
    } catch (e) {
      const msg = describeError(e);
      store.setAccountError(account.id, msg);
      log(`[refresh] ${account.name} 失败: ${msg}`);
      results.push({ account: account.name, ok: false, error: msg, products: 0 });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  log(`[refresh] 完成：${okCount}/${results.length} 个账号成功`);
  return { ok: okCount > 0, okCount, total: results.length, results };
}

/** 刷新单个套餐的流量（不登录，直接回源） */
export async function refreshPlanTraffic(productId) {
  rebuildRuntime();
  const p = store.data.products.find((x) => x.id === productId);
  if (!p) throw new Error('未知套餐');
  const account = store.getAccount(p.accountId);
  if (!account) throw new Error('套餐所属账号不存在');
  return refreshAccount(account, { onlyProductId: productId });
}

/* ---- 刷新授权（上游订阅失效时的自愈） ----
 * 本项目根本目的就是让订阅地址一直生效：客户端用本服务的地址拉订阅，
 * 上游报错（开关过期/token 失效）时，自动重新登录+激活+抓取，再重试。
 * 同一账号的并发触发合并为一次；60 秒内不重复刷 —— 客户端可能在
 * 自动重试循环里，不设冷却会把机场打疼。 */

const reauthInFlight = new Map();
const reauthLastAt = new Map();
const REAUTH_COOLDOWN_MS = 60_000;

/**
 * 刷新一个账号的授权：登录 → 激活订阅开关 → 重新抓取套餐与订阅。
 * 返回 true=授权已刷新（可重试拉取）；false=刚刷过（冷却中）或刷新失败。
 */
export function reauthorize(account) {
  const now = Date.now();
  if ((reauthLastAt.get(account.id) || 0) > now - REAUTH_COOLDOWN_MS) return Promise.resolve(false);
  if (reauthInFlight.has(account.id)) return reauthInFlight.get(account.id);

  const task = (async () => {
    try {
      log(`[reauth] ${account.name}：上游订阅失效，重新登录并激活`);
      const discovered = await discoverAccount(account);
      store.saveDiscovered(account.id, discovered);
      store.setAccountError(account.id, '');
      log(`[reauth] ${account.name}：授权已刷新（${discovered.length} 个套餐）`);
      return true;
    } catch (e) {
      const msg = describeError(e);
      store.setAccountError(account.id, msg);
      log(`[reauth] ${account.name} 失败: ${msg}`);
      return false;
    } finally {
      reauthLastAt.set(account.id, Date.now());
      reauthInFlight.delete(account.id);
    }
  })();
  reauthInFlight.set(account.id, task);
  return task;
}

/** 套餐运行状态查询（/status 用） */
export function productRuntime(productId) {
  return runtime.get(productId) || { refreshing: false };
}

/* ------------------------------------------------------------------ */
/* 状态载荷（/status 与管理页 /api/status 共用）                        */
/* ------------------------------------------------------------------ */

/**
 * 输出账号 / 套餐 / 订阅的状态 JSON。
 * tokens=false 时订阅地址不带 token —— /status 允许用单条订阅的 token 调用，
 * 不能让持有者顺走其它订阅的 token（管理会话才给完整地址）。
 * realUrls=true 时附带机场返回的原始订阅地址（仅管理页 /api/status 用）。
 */
export function statusPayload({ tokens = true, realUrls = false } = {}) {
  const accounts = store.data.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    baseUrl: a.baseUrl,
    email: a.email,
    hasPassword: !!a.password,
    lastError: a.lastError || '',
    lastErrorAt: a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
    productCount: store.data.products.filter((p) => p.accountId === a.id).length,
  }));

  const products = store.data.products.map((p) => {
    const account = store.getAccount(p.accountId);
    // userinfo 里的 expire 是秒级时间戳，优先用它；否则用列表页解析的日期。
    // 注意 expire=0（无期限）是 falsy，不能走 Number.isFinite 否则会显示 1970
    let expire = p.expire || '';
    if (p.traffic?.expire) {
      const d = new Date(p.traffic.expire * 1000);
      if (!Number.isNaN(d.getTime())) expire = dateOnly(d);
    }
    return {
      id: p.id,
      accountId: p.accountId,
      accountName: account?.name || '',
      serviceId: p.serviceId,
      name: p.name,
      expire,
      traffic: p.traffic,
      trafficUpdatedAt: p.trafficUpdatedAt ? new Date(p.trafficUpdatedAt).toISOString() : null,
      lastError: p.lastError || '',
      lastErrorAt: p.lastErrorAt ? new Date(p.lastErrorAt).toISOString() : null,
      refreshing: productRuntime(p.id).refreshing,
      subs: (p.subs || []).map((s) => {
        const subPath = `/sub/${p.id}-${s.id}`;
        const out = { key: `${p.id}-${s.id}`, name: s.name };
        if (realUrls) out.url = s.url;
        // 设了 PUBLIC_URL 给完整地址；没设只给路径，前端按浏览器地址栏补全
        out.subUrl =
          (config.publicUrl ? config.publicUrl + subPath : subPath) + (tokens ? `?token=${s.token}` : '');
        return out;
      }),
    };
  });

  return {
    accounts,
    products,
    updatedAt: store.data.updatedAt ? new Date(store.data.updatedAt).toISOString() : null,
  };
}

/** 进程退出时释放 FlareSolverr 会话 */
export async function shutdown() {
  await fsp.closeSession().catch(() => {});
}