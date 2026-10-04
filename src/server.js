import express from 'express';
import { config } from './config.js';
import { store } from './store.js';
import { refreshAll, refreshAccount, refreshPlanTraffic, describeError, reauthorize, statusPayload, syncTrafficFromSubFetch, withRefreshMarker } from './state.js';
import { fetchSubscription } from './fetchsub.js';
import { autoRefreshStatus } from './scheduler.js';
import { log } from './logtime.js';
import { registerAdminRoutes, hasValidSession, safeEqual, sameOriginOnly } from './admin.js';

/**
 * 保护订阅输出接口（/sub）。
 * 优先级：管理会话 Cookie → 该订阅链接自己的 token。
 * 每条订阅一个独立 token（config.json 里 subs[].token），
 * 泄露一条不影响其它，也可以单独轮换。
 */
function checkAuth(req, res, next) {
  if (hasValidSession(req)) return next();

  const provided = req.query.token || req.get('x-access-token') || '';

  // 确定要校验哪条订阅：路径带 key 就是它；没带 key 时只有一条订阅会自动选中
  let entry;
  if (req.params.key) {
    entry = store.findSub(req.params.key); // 未知 key → null，交给 subHandler 返回 404
  } else {
    const subs = store.listSubs();
    entry = subs.length === 1 ? subs[0] : null;
  }

  // 有明确目标订阅：只认这条订阅自己的 token（避免单订阅部署下 /sub 免鉴权）
  if (entry) {
    if (provided && safeEqual(provided, entry.sub.token)) return next();
    return res.status(401).type('text/plain').send('# unauthorized: 缺少或错误的订阅 Token');
  }

  // 多条订阅且未指定 key：下面只返回 key 列表，不含订阅内容，无需 token。
  // ⚠️ 这个放行分支只允许用在 /sub —— 会返回数据的接口（/status /refresh）
  // 必须用 strictAuth，否则未鉴权就能拿走全部订阅 token
  next();
}

/**
 * 严格鉴权（/status /refresh 这类会返回数据的机器接口）：
 * 管理会话，或任意一条订阅的有效 token。
 * 与 checkAuth 的本质区别：没有「多订阅放行」分支 —— /status 的响应里
 * 有全部订阅的地址与 token，绝不能发给未鉴权的请求。
 */
function strictAuth(req, res, next) {
  if (hasValidSession(req)) return next();

  const provided = req.query.token || req.get('x-access-token') || '';
  const subs = store.listSubs();
  if (provided && subs.some((e) => safeEqual(provided, e.sub.token))) return next();
  return res.status(401).type('text/plain').send('# unauthorized: 缺少或错误的订阅 Token');
}

/**
 * 求出本次请求要输出的订阅 key。
 * 指定了 key 但不存在 → 已写 404 并返回 null；未指定 key 且只有一条订阅 →
 * 自动选中它；否则已写 400 可用列表并返回 null。
 */
function resolveKey(req, res) {
  const key = req.params.key;
  if (key) {
    if (!store.findSub(key)) {
      res
        .status(404)
        .type('text/plain')
        .send(`# 未知订阅链接: ${key}\n# 可用列表见管理页 /dashboard`);
      return null;
    }
    return key;
  }
  const subs = store.listSubs();
  if (subs.length === 1) return subs[0].key;
  // 不回显 token：这里可能未鉴权，且 token 属于密钥
  res
    .status(400)
    .type('text/plain')
    .send(
      '# 配置了多条订阅链接，请在路径里指定，例如 /sub/<key>\n' +
        subs.map((e) => `#   /sub/${e.key}    ${e.product.name} / ${e.sub.name}`).join('\n')
    );
  return null;
}

function sendSubscription(res, out) {
  // 客户端约定：24 小时更新一次
  res.set('profile-update-interval', '24');
  // 流量信息是套餐级的，但客户端从每条订阅的响应头读，这里透传
  if (out.userInfo) res.set('subscription-userinfo', out.userInfo);
  // attachment：浏览器直接下载，而不是把 YAML 当网页内联渲染
  if (out.disposition) res.set('content-disposition', out.disposition);
  res.set('cache-control', 'no-store');
  res.type(out.contentType).send(out.body);
}

/** 实时回源 + 输出（三处 /sub 路由共用） */
async function subHandler(req, res) {
  const key = resolveKey(req, res); // 400/404 已由 resolveKey 写出
  if (!key) return;
  const entry = store.findSub(key);
  if (!entry) {
    res.status(404).type('text/plain').send(`# 未知订阅链接: ${key}`);
    return;
  }
  // 回源沿用调用方（订阅客户端）的 UA，客户端用哪种就回哪种
  const userAgent = req.get('user-agent') || '';
  try {
    let out;
    let used = entry; // 实际回源的条目；reauth 后可能换成本次重抓的
    try {
      out = await fetchSubscription(entry, userAgent);
    } catch (e) {
      // 本项目根本目的：让订阅地址一直生效。上游报错（订阅开关过期 /
      // token 失效）时自动刷新授权（重新登录+激活+抓取），再重试一次。
      // 冷却期内或刷新失败则把原始错误交给客户端。
      const account = store.getAccount(entry.product.accountId);
      const refreshed = account ? await reauthorize(account) : false;
      if (!refreshed) throw e;
      const fresh = store.findSub(entry.key);
      if (!fresh) {
        throw new Error(
          '刷新授权后该订阅已不在套餐里（可能已更换或下架），请到仪表盘重新「刷新全部」',
          { cause: e }
        );
      }
      out = await fetchSubscription(fresh, userAgent);
      used = fresh;
    }
    // 回源响应里的 subscription-userinfo 顺带写回套餐流量：客户端每拉一次，
    // 仪表盘的流量就同步一次（reauth 后的重试也走这里），不用等手动刷新
    syncTrafficFromSubFetch(used.product.id, out.userInfo);
    sendSubscription(res, out);
  } catch (e) {
    res.status(502).type('text/plain').send(`# helper error: ${describeError(e)}`);
  }
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  /* ---------------- 订阅输出（实时回源，不缓存） ---------------- */

  app.get('/sub', checkAuth, subHandler);
  app.get('/sub/:key', checkAuth, subHandler);
  app.get('/subscribe/:key', checkAuth, subHandler);

  /* ---------------- 状态 ---------------- */

  // 非管理会话（即用订阅 token 调用）时响应里不带任何 token，
  // 持有单条订阅 token 的调用方不能顺走其它订阅的
  app.get('/status', strictAuth, (req, res) =>
    res.json({ ...statusPayload({ tokens: hasValidSession(req) }), autoRefresh: autoRefreshStatus() })
  );

  /* ---------------- 手动刷新 ---------------- */

  // 刷新粒度：套餐流量（快，不登录）→ 单账号（登录+抓结构+流量）→ 全部
  app.post('/refresh', strictAuth, sameOriginOnly, async (req, res) => {
    try {
      const { productId, accountId } = req.body || {};
      if (productId) {
        const out = await refreshPlanTraffic(String(productId));
        return res.json({ ok: out.ok, results: [out] });
      }
      if (accountId) {
        const account = store.getAccount(String(accountId));
        if (!account) return res.status(404).json({ ok: false, error: '未知机场账号' });
        // 整段请求都算「刷新中」：仪表盘的「刷新全部」就是按账号连打这个接口，
        // 标记上之后定时那一轮才会真的跳过，而不是挤进来排队
        const out = await withRefreshMarker(refreshAccount(account));
        return res.json({ ok: out.ok, okCount: out.ok ? 1 : 0, total: 1, results: [out] });
      }
      const out = await refreshAll('manual');
      // 全部账号都失败时按失败语义返回 400（部分成功仍是 200 + ok:false）
      if (!out.ok) {
        const first = out.results.find((r) => r.error);
        return res.status(400).json({
          ok: false,
          error: first?.error || '全部账号刷新失败',
          okCount: out.okCount,
          total: out.total,
          results: out.results,
        });
      }
      res.json(out);
    } catch (e) {
      // 未配置账号等业务性错误：400 + 明确提示，让前端能直接展示
      res.status(400).json({ ok: false, error: describeError(e) });
    }
  });

  app.get('/health', (req, res) => res.type('text/plain').send('ok'));

  // 管理页面挂在根路径（/dashboard 仪表盘、/config 设置）
  registerAdminRoutes(app);

  app.use((req, res) => res.status(404).type('text/plain').send('not found'));

  // 统一错误处理：本机裸跑时 NODE_ENV 不是 production，
  // Express 默认错误页会把 stack trace 返回给客户端
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`[http] ${req.method} ${req.originalUrl} 处理异常:`, err?.message || err);
    if (res.headersSent) return;
    res.status(500).type('text/plain').send('internal error');
  });

  return app;
}

export function startServer() {
  const app = createServer();
  const server = app.listen(config.port, '0.0.0.0', () => {
    const subCount = store.listSubs().length;
    log(`[http] 监听 0.0.0.0:${config.port}`);
    log(
      `[http] 配置来源  ${config.configFile}` +
        `（${store.data.accounts.length} 个机场账号 / ${store.data.products.length} 个套餐 / ${subCount} 条订阅）`
    );
    for (const a of store.data.accounts) {
      log(`[http]   账号 ${a.name} <${a.email}> → ${a.baseUrl}`);
    }
    log(`[http] 管理页面  http://<本机IP>:${config.port}/dashboard`);
    log(`[http] FlareSolverr  ${config.flareSolverrUrl}`);
    if (!store.data.adminPassword) log('[http] 管理口令未设置：首次访问将进入「首次设置」页');
    if (!store.data.accounts.length) {
      log('[SECURITY] 尚未配置机场账号：请到管理页「设置」填写，否则无法抓取套餐与订阅');
    }
  });
  return server;
}