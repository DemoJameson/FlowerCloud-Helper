/**
 * 业务配置存储：/data/config.json（管理页读写、导出导入的就是它）。
 *
 * 数据模型：
 *   accounts[]   机场账号：机场名 + 地址 + 邮箱 + 密码（可配多个，同机场不同账号）
 *   products[]   抓取到的套餐，归属某个账号；流量/到期是套餐级信息，
 *                刷新时每个套餐只拉一条订阅即可拿到（各订阅共用同一个上游 token）
 *                subs[] 是当前活动订阅；retiredSubs[] 保存短暂消失过的
 *                id/token，只用于恢复旧地址，不对外展示
 *   autoRefreshMinutes  自动「刷新全部」的间隔（分钟），0 = 关闭，默认 20
 *
 * 用户只需要填账号，套餐与订阅链接全部由程序登录后自动获取。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './logtime.js';

const HTTP_RE = /^https?:\/\//i;
export const DEFAULT_BASE_URL = 'https://api-flowercloud.com';
export const DEFAULT_ACCOUNT_NAME = '花云';

/**
 * 自动「刷新全部」的间隔（分钟）。0 = 关闭（只保留手动刷新与失效自愈）。
 * 上限 1 天：再长没有意义，再短会把机场打疼（每次都要登录面板抓一遍）。
 */
export const DEFAULT_AUTO_REFRESH_MINUTES = 20;
export const MAX_AUTO_REFRESH_MINUTES = 24 * 60;

/**
 * 归一自动刷新间隔。手改配置写坏了也不该让服务起不来，所以这里只做
 * 收敛不抛错：非数字 → 默认值，负数 → 0，超大 → 上限。需要严格校验的
 * 入口（管理页保存）自己先判一次再调进来。
 */
export function normalizeAutoRefreshMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AUTO_REFRESH_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_AUTO_REFRESH_MINUTES;
  return Math.min(MAX_AUTO_REFRESH_MINUTES, Math.max(0, Math.round(n)));
}

function fail(msg) {
  throw new Error(`配置错误：${msg}`);
}

/** 32 位十六进制随机 token，URL 安全 */
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 把本次抓到的订阅与旧条目对上，沿用旧条目的 id 与 token。
 *
 * 为什么要按 name 兜底匹配：机场的上游订阅地址是会变的（重新激活开关、
 * 上游轮换 token、参数顺序调整都会让 url 变），而客户端手里只有我们
 * 发的本地地址。只按 url 匹配，一旦机场换了地址就会给用户重新生成
 * token —— 本地订阅地址跟着失效，客户端全部掉线，这正是本项目要
 * 消灭的事。所以 url 变了但订阅还是同一条时，必须认出来。
 *
 * 匹配分层，先精确后模糊，且每条旧记录只用一次（避免两条新订阅抢同一条旧记录）：
 *   1. url 完全相同
 *   2. 订阅类型签名相同（target + filename，上游 token 轮换时通常保持不变）
 *   3. name 相同（订阅名由机场页面给出，如「Clash」「Trojan Surge」，语义稳定）
 *
 * 不按位置猜身份：机场删掉一条、新增另一条时，按位置复用 token 会让
 * 旧地址开始返回另一条订阅。认不出来就生成新 token，正确性优先。
 *
 * **必须分层整轮跑，不能一条一条顺着降级**：先让所有新订阅完成精确 url
 * 匹配，再做签名/名称匹配。否则一条新增订阅可能先抢走后面某条旧记录的
 * token，等真正的旧订阅轮到匹配时已经无记录可用。
 */
function matchSubs(oldSubs, newSubs, retiredSubs = []) {
  const valid = newSubs.filter((s) => HTTP_RE.test(String(s?.url || '')));

  // name 归一化：机场页面上的空白/大小写差异不该让匹配落空
  const key = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // 转换站链接的 target/filename 是订阅类型，不随上游 token 变化；
  // 两者都没有的直连地址返回空串，不参与这一层匹配。
  const signatureOf = (s) => {
    try {
      const u = new URL(String(s?.url || ''));
      const target = String(u.searchParams.get('target') || '').trim().toLowerCase();
      const filename = String(u.searchParams.get('filename') || '').trim().toLowerCase();
      return target || filename ? `${target}|${filename}` : '';
    } catch {
      return '';
    }
  };

  // 当前订阅排在前面，历史订阅排在后面。这样同一个 id/token 同时出现在
  // 两处时（旧版本配置或异常写入）永远优先使用当前记录。
  const oldPool = [];
  const seen = new Set();
  for (const sub of [...oldSubs, ...retiredSubs]) {
    if (!HTTP_RE.test(String(sub?.url || ''))) continue;
    const id = String(sub?.id || '').trim();
    const token = String(sub?.token || '').trim();
    if ((id && seen.has(`id:${id}`)) || (token && seen.has(`token:${token}`))) continue;
    if (id) seen.add(`id:${id}`);
    if (token) seen.add(`token:${token}`);
    oldPool.push({ sub, used: false });
  }
  const claimed = new Array(valid.length).fill(null);

  /** 把本轮仍未认领、且满足 pred 的第一条旧记录认领给第 i 条新订阅 */
  const claim = (i, pred) => {
    if (claimed[i]) return;
    const hit = oldPool.find((o) => !o.used && pred(o.sub, i, o));
    if (!hit) return;
    hit.used = true;
    claimed[i] = hit.sub;
  };

  const urlOf = (s) => String(s.url).trim();
  const nameOf = (s, i) => String(s.name || '').trim() || `订阅 ${i + 1}`;

  // 每层跑完整一轮：先精确后模糊，且不会互相抢占
  for (let i = 0; i < valid.length; i++) claim(i, (o) => o.url === urlOf(valid[i]));

  // 签名必须在新旧两边都唯一才采用，避免多条 Clash 类订阅互相抢 token。
  const oldSigCount = new Map();
  const newSigCount = new Map();
  for (const o of oldPool) {
    const sig = signatureOf(o.sub);
    if (sig) oldSigCount.set(sig, (oldSigCount.get(sig) || 0) + 1);
  }
  for (const s of valid) {
    const sig = signatureOf(s);
    if (sig) newSigCount.set(sig, (newSigCount.get(sig) || 0) + 1);
  }
  for (let i = 0; i < valid.length; i++) {
    const sig = signatureOf(valid[i]);
    if (!sig || oldSigCount.get(sig) !== 1 || newSigCount.get(sig) !== 1) continue;
    claim(i, (o) => signatureOf(o) === sig);
  }

  for (let i = 0; i < valid.length; i++) {
    const name = key(nameOf(valid[i], i));
    if (name) claim(i, (o) => key(o.name) === name);
  }

  return {
    subs: valid.map((s, i) => {
      const kept = claimed[i];
      return {
        id: kept?.id || genId(),
        name: nameOf(s, i),
        url: urlOf(s),
        token: kept?.token || genToken(),
      };
    }),
    // 本轮没出现的旧订阅不直接丢掉：只从活动列表隐藏，但保留 id/token。
    // 机场页面偶尔会漏掉某一条，等它下次出现时仍能恢复原来的本地地址。
    retiredSubs: oldPool.filter((o) => !o.used).map((o) => o.sub),
  };
}

/** 6 位十六进制 id（URL 安全） */
function genId() {
  return crypto.randomBytes(8).toString('hex').slice(0, 6);
}

function pickId(raw, where, seen) {
  let id = String(raw ?? '').trim();
  if (!id) id = genId();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) fail(`${where} 的 id「${id}」只能包含字母、数字、下划线和短横线（≤32 位）`);
  if (seen.has(id)) fail(`${where} 的 id「${id}」重复`);
  seen.add(id);
  return id;
}

/**
 * 机场地址归一：允许填域名、带斜杠、或直接填 clientarea.php。
 * 统一存成「站点根地址」，拼页面地址时再加 clientarea.php。
 */
export function normalizeBaseUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return DEFAULT_BASE_URL;
  if (!HTTP_RE.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/clientarea\.php$/i, '');
  return s;
}

/** 站点根地址 → 客户中心页 */
export function clientAreaUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/clientarea.php`;
}

/** 站点根地址 → 套餐详情页 */
export function productDetailsUrl(baseUrl, serviceId) {
  return `${clientAreaUrl(baseUrl)}?action=productdetails&id=${encodeURIComponent(serviceId)}`;
}

/* ------------------------------------------------------------------ */
/* 账号                                                                 */
/* ------------------------------------------------------------------ */

/* ---- 机场账号密码：可逆加密存储（AES-256-GCM） ----
 * 登录面板时需要还原明文提交表单，所以只能可逆。
 * 加密密钥由「邮箱」派生 —— 导出文件拿到任何新设备导入都能解开。
 * 这层保证「文件不直接可读」，不对抗拿到整份配置的人 —— 邮箱就在旁边。 */

function pwKey(email) {
  // 小写化：用户后来改邮箱大小写也不至于解不开
  return crypto.scryptSync(String(email).trim().toLowerCase(), 'flowercloud-helper.password', 32);
}

/** 明文 → 密文；空值或已是密文则原样返回（幂等，避免二次加密） */
function encryptPassword(pw, email) {
  const s = String(pw ?? '');
  if (!s || s.startsWith('enc:')) return s;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', pwKey(email), iv);
  const data = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return 'enc:' + [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** 密文 → 明文；解不开视为没设密码；非密文原样返回 */
function decryptPassword(stored, email) {
  const s = String(stored ?? '');
  if (!s.startsWith('enc:')) return s;
  try {
    const [ivB64, tagB64, dataB64] = s.slice('enc:'.length).split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      pwKey(email),
      Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return '';
  }
}

/* ---- 管理口令：明文存于配置文件（便于本地找回），仅做强度校验 ---- */

/** 校验管理口令强度；通过返回 ''，否则返回给用户看的错误信息 */
export function validateAdminPassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return '管理口令至少 8 个字符';
  if (!/[0-9]/.test(s)) return '管理口令必须包含至少一个数字（0–9）';
  if (!/[A-Z]/.test(s)) return '管理口令必须包含至少一个大写字母（A–Z）';
  if (!/[a-z]/.test(s)) return '管理口令必须包含至少一个小写字母（a–z）';
  return '';
}

function normAccount(raw, where, seen) {
  const name = String(raw?.name ?? '').trim() || DEFAULT_ACCOUNT_NAME;
  const baseUrl = normalizeBaseUrl(raw?.baseUrl);
  const email = String(raw?.email ?? '').trim();
  if (!email) fail(`${where}（${baseUrl}）缺少邮箱`);
  const password = encryptPassword(raw?.password, email);

  return {
    id: pickId(raw?.id, where, seen),
    name,
    baseUrl,
    email,
    password,
    // 运行状态：登录/抓取失败的提示（刷新成功后清空）
    lastError: String(raw?.lastError ?? ''),
    lastErrorAt: Number(raw?.lastErrorAt) || 0,
  };
}

/** 校验一条订阅；活动列表与历史列表共用，保证恢复时 id/token 仍合法 */
function normSub(raw, where, seen, usedTokens, fallbackName = '订阅') {
  const url = String(raw?.url ?? '').trim();
  if (!url) fail(`${where} 缺少 url`);
  if (!HTTP_RE.test(url)) fail(`${where} 的 url 必须以 http(s):// 开头`);

  const token = String(raw?.token ?? '').trim() || genToken();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) fail(`${where} 的 token 格式不合法`);
  if (usedTokens.has(token)) fail(`${where} 的 token 与其它订阅重复`);
  usedTokens.add(token);

  return {
    id: pickId(raw?.id, where, seen),
    name: String(raw?.name ?? '').trim() || fallbackName,
    url,
    token,
  };
}

/** 校验管理页提交的自动刷新间隔；通过返回 ''，否则返回给用户看的错误信息 */
export function validateAutoRefreshMinutes(raw) {
  const n = Number(raw);
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) {
    return '自动刷新间隔必须是数字（分钟），0 表示关闭';
  }
  if (n < 0 || n > MAX_AUTO_REFRESH_MINUTES) {
    return `自动刷新间隔需在 0（关闭）到 ${MAX_AUTO_REFRESH_MINUTES} 分钟之间`;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 套餐与订阅（程序抓取，也可手工预填）                                   */
/* ------------------------------------------------------------------ */

function normProducts(raw, where, seen, accounts, usedTokens) {
  const out = [];
  const accIds = new Set(accounts.map((a) => a.id));
  // (accountId, serviceId) 组合唯一 —— 同一机场多账号会有相同 serviceId
  const pairSeen = new Set();

  for (const [i, p] of (Array.isArray(raw) ? raw : []).entries()) {
    const at = `${where}[${i}]`;
    const serviceId = String(p?.serviceId ?? '').trim();
    if (!/^\d+$/.test(serviceId)) fail(`${at} 的 serviceId 必须是数字（套餐 ID）`);

    let accountId = String(p?.accountId ?? '').trim();
    if (!accIds.has(accountId)) {
      // 未指明归属时挂到第一个账号（单账号场景等价于默认）
      accountId = accounts[0]?.id || '';
      if (!accountId) fail(`${at} 缺少 accountId（先配置机场账号）`);
    }
    const pair = `${accountId}|${serviceId}`;
    if (pairSeen.has(pair)) {
      // 重复的（账号, 套餐）组合只保留第一条 —— 数据是程序自动生成的，
      // 拒绝启动只会让服务无法自愈（旧版本 bug 可能已把重复写进配置文件）
      console.warn(`[store] ${at} 与其它套餐重复（账号 ${accountId} 的 ${serviceId}），已忽略`);
      continue;
    }
    pairSeen.add(pair);

    // 流量是套餐级信息：来自 subscription-userinfo 响应头
    const traffic = p?.traffic && Number.isFinite(Number(p.traffic.total)) ? p.traffic : null;

    const subs = (Array.isArray(p?.subs) ? p.subs : []).map((s, j) =>
      normSub(s, `${at}.subs[${j}]`, seen, usedTokens, `订阅 ${j + 1}`)
    );

    // 历史订阅只用于复用旧 id/token，不参与 /status、列表展示或订阅输出。
    // 配置升级时缺失该字段等价于空历史；重复项直接跳过，避免旧数据阻断启动。
    const retiredIds = new Set(subs.map((s) => s.id));
    const retiredTokens = new Set(subs.map((s) => s.token));
    const retiredSubs = [];
    for (const [j, s] of (Array.isArray(p?.retiredSubs) ? p.retiredSubs : []).entries()) {
      const rawId = String(s?.id ?? '').trim();
      const rawToken = String(s?.token ?? '').trim();
      const url = String(s?.url ?? '').trim();
      if (!HTTP_RE.test(url) || !/^[A-Za-z0-9_-]{16,64}$/.test(rawToken)) continue;
      if ((rawId && (retiredIds.has(rawId) || seen.has(rawId))) || usedTokens.has(rawToken)) {
        continue;
      }
      const sub = normSub(s, `${at}.retiredSubs[${j}]`, seen, usedTokens);
      retiredIds.add(sub.id);
      retiredTokens.add(sub.token);
      retiredSubs.push(sub);
    }

    out.push({
      id: pickId(p?.id, at, seen),
      accountId,
      serviceId,
      name: String(p?.name ?? '').trim() || `套餐 ${serviceId}`,
      // 列表页解析出的到期日期；刷新流量时会被 userinfo 里的时间戳覆盖展示
      expire: String(p?.expire ?? '').trim(),
      traffic,
      trafficUpdatedAt: Number(p?.trafficUpdatedAt) || 0,
      lastError: String(p?.lastError ?? ''),
      lastErrorAt: Number(p?.lastErrorAt) || 0,

      subs,
      retiredSubs,
    });
  }
  return out;
}

/** 校验并补全整份配置；非法直接抛错（信息面向配置页展示） */
export function normalize(raw, { seenIds = null } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('顶层必须是一个 JSON 对象');
  }
  const seen = seenIds || new Set();
  const usedTokens = new Set();

  const accounts = (Array.isArray(raw?.accounts) ? raw.accounts : []).map((a, i) =>
    normAccount(a, `accounts[${i}]`, seen)
  );

  const out = {
    version: 1,
    accounts,
    products: normProducts(raw?.products, 'products', seen, accounts, usedTokens),
    sessionSecret: String(raw?.sessionSecret ?? '').trim(),
    // 管理口令：明文存储（网页设置，便于从配置文件直接找回）
    adminPassword: String(raw?.adminPassword ?? ''),
    // 自动「刷新全部」间隔（分钟）；0 = 关闭。默认 20 分钟（见 scheduler.js）
    autoRefreshMinutes: normalizeAutoRefreshMinutes(raw?.autoRefreshMinutes),
    updatedAt: Number(raw?.updatedAt) || 0,
  };

  if (!out.sessionSecret) out.sessionSecret = crypto.randomBytes(32).toString('hex');
  return out;
}

/* ------------------------------------------------------------------ */
/* 存储                                                                 */
/* ------------------------------------------------------------------ */

function loadOrCreate() {
  const file = config.configFile;
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = normalize(raw);
    // 旧配置里的密码是明文，normalize 已在内存中加密 —— 写回，落盘即密文
    saveData(file, data);
    log(`[store] 已加载配置 ${file}（${data.accounts.length} 个账号 / ${data.products.length} 个套餐）`);
    return data;
  }
  const data = normalize({});
  saveData(file, data);
  log(`[store] 首次运行，已生成配置 ${file}`);
  return data;
}

function saveData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写：先写临时文件再改名，避免写一半被读到 / 掉电损坏
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.file = config.configFile;
    this.data = loadOrCreate();
  }

  save() {
    saveData(this.file, this.data);
  }

  /** 覆盖整份配置（导入）。校验失败抛错，成功后落盘 */
  replace(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('配置格式不正确（应为本程序导出的 JSON）');
    }
    const data = normalize(raw);
    // 导入只覆盖账号/套餐等业务数据：本机的管理口令与会话密钥保持不动，
    // 避免导入后口令被静默替换、当前登录被踢下线（导出文件也不含这两项）
    data.adminPassword = this.data.adminPassword;
    data.sessionSecret = this.data.sessionSecret;
    this.data = data;
    this.save();
    return data;
  }

  /**
   * 保存账号列表。密码留空表示保持原值（页面上是密码框，不回填）。
   * 按 (baseUrl+email) 匹配旧账号沿用 id，避免订阅地址全部失效。
   */
  saveAccounts(list) {
    if (!Array.isArray(list)) fail('账号格式不正确');
    const old = new Map(this.data.accounts.map((a) => [`${a.baseUrl}|${a.email}`, a]));

    const seen = new Set();
    // 本次提交内出现过的 (地址|邮箱)：同一个登录不允许提交两次 ——
    // 两条全新且相同登录的条目若不拦，会各自生成 id，刷新后套餐在两个账号下各一份
    const submitted = new Set();
    const accounts = list.map((a, i) => {
      const key = `${normalizeBaseUrl(a?.baseUrl)}|${String(a?.email ?? '').trim()}`;
      if (submitted.has(key)) {
        fail(
          `accounts[${i}]（${a?.name || DEFAULT_ACCOUNT_NAME}）与本次提交里的其它账号` +
            '是同一个登录（地址+邮箱相同），不能重复添加；如需改名请直接修改原账号'
        );
      }
      submitted.add(key);
      const prev = old.get(key);
      // 新条目（没带 id）但 (地址,邮箱) 撞上已有账号：同一个登录不允许重复添加，
      // 否则旧 id 会被套到新条目上，报出的「id 重复」用户根本看不懂
      if (!a?.id && prev && seen.has(prev.id)) {
        fail(
          `accounts[${i}]（${a?.name || prev.name}）与已有账号「${prev.name}」是同一个登录（地址+邮箱相同），不能重复添加；如需改名请直接修改原账号`
        );
      }
      const norm = normAccount(
        { ...a, id: a?.id || prev?.id, password: a?.password || prev?.password || '' },
        `accounts[${i}]`,
        seen
      );
      // 沿用旧账号的运行状态
      if (prev) {
        norm.lastError = prev.lastError;
        norm.lastErrorAt = prev.lastErrorAt;
      }
      return norm;
    });

    this.data.accounts = accounts;
    // 删掉账号后，其名下套餐一并移除（订阅地址本来也访问不了了）
    const alive = new Set(accounts.map((a) => a.id));
    this.data.products = this.data.products.filter((p) => alive.has(p.accountId));
    this.save();
    return accounts;
  }

  getAccount(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  /**
   * 保存某个账号抓取到的套餐。
   * 按 (accountId, serviceId) 匹配旧条目，沿用已有 id / token / traffic，
   * 保证客户端订阅地址在多次抓取之间保持稳定。
   */
  saveDiscovered(accountId, discovered) {
    const account = this.getAccount(accountId);
    if (!account) fail(`未知账号 ${accountId}`);

    const oldById = new Map();
    for (const p of this.data.products) {
      if (p.accountId !== accountId) continue;
      oldById.set(String(p.serviceId), p);
    }

    const merged = discovered.map((p) => {
      const serviceId = String(p.serviceId || '').trim();
      const prev = oldById.get(serviceId);
      const oldSubs = Array.isArray(prev?.subs) ? prev.subs : [];
      const retiredSubs = Array.isArray(prev?.retiredSubs) ? prev.retiredSubs : [];
      const incomingSubs = (Array.isArray(p.subs) ? p.subs : []).filter((s) =>
        HTTP_RE.test(String(s?.url || ''))
      );
      // 详情页抓取失败时 state 会传 subsComplete=false。此时绝不能把
      // 现有订阅覆盖成空数组，否则下一次成功刷新会为同一订阅重新发 token。
      const hasSnapshot =
        p.subsComplete === true || (p.subsComplete !== false && incomingSubs.length > 0);
      const matched = hasSnapshot
        ? matchSubs(oldSubs, incomingSubs, retiredSubs)
        : { subs: oldSubs, retiredSubs };
      return {
        id: prev?.id || genId(),
        accountId,
        serviceId,
        name: String(p.name || '').trim() || `套餐 ${serviceId}`,
        expire: String(p.expire || '').trim(),
        traffic: prev?.traffic ?? null,
        trafficUpdatedAt: prev?.trafficUpdatedAt ?? 0,
        lastError: prev?.lastError ?? '',
        lastErrorAt: prev?.lastErrorAt ?? 0,
        subs: matched.subs,
        retiredSubs: matched.retiredSubs,
      };
    });

    // 组装：其它账号的套餐 + 本账号这次没抓到的旧套餐（可能临时下架，保留）。
    // 注意 merged 里已包含「匹配到旧套餐」的新版本（沿用其 id），
    // rest 里绝不能再保留它们 —— 否则每刷新一次就重复一份。
    const mergedIds = new Set(merged.map((p) => p.id));
    const rest = this.data.products.filter(
      (p) => p.accountId !== accountId || !mergedIds.has(p.id)
    );
    this.data.products = [...rest, ...merged];
    this.data.updatedAt = Date.now();
    this.save();
    return merged;
  }

  /** 套餐级流量：来自 subscription-userinfo，刷新流量时写入 */
  setProductTraffic(productId, traffic) {
    const p = this.data.products.find((x) => x.id === productId);
    if (!p) return;
    p.traffic = traffic;
    p.trafficUpdatedAt = Date.now();
    p.lastError = '';
    p.lastErrorAt = 0;
    this.save();
  }

  setProductError(productId, message) {
    const p = this.data.products.find((x) => x.id === productId);
    if (!p) return;
    p.lastError = message;
    p.lastErrorAt = Date.now();
    this.save();
  }

  setAccountError(accountId, message) {
    const a = this.getAccount(accountId);
    if (!a) return;
    a.lastError = message;
    a.lastErrorAt = message ? Date.now() : 0;
    this.save();
  }

  /** 轮换单条订阅的 token：旧地址立刻失效，只有这一条受影响 */
  regenerateSubToken(key) {
    const entry = this.findSub(key);
    if (!entry) return null;
    const oldToken = entry.sub.token;
    const used = new Set([
      ...this.listSubs().map((e) => e.sub.token),
      ...this.data.products.flatMap((p) => (p.retiredSubs || []).map((s) => s.token)),
    ]);
    let token = genToken();
    while (used.has(token)) token = genToken();
    entry.sub.token = token;
    // 手动轮换意味着旧 token 必须永久作废，历史记录也不能把它复活。
    entry.product.retiredSubs = (entry.product.retiredSubs || []).filter(
      (s) => s.id !== entry.sub.id && s.url !== entry.sub.url && s.token !== oldToken
    );
    this.save();
    return token;
  }

  /** 登录面板用的明文密码（配置里存的是密文，按邮箱派生密钥解密） */
  plainPassword(account) {
    return decryptPassword(account?.password, account?.email);
  }

  /** 管理口令（明文存于配置文件，便于本地找回） */
  plainAdminPassword() {
    return String(this.data.adminPassword ?? '');
  }

  /**
   * 设置自动「刷新全部」的间隔（分钟），0 = 关闭。返回落盘后的值。
   * 调用方（管理页接口）应先过 validateAutoRefreshMinutes 给出明确报错；
   * 这里只做收敛，非法值按默认处理，避免写坏配置后服务起不来。
   */
  setAutoRefreshMinutes(minutes) {
    const n = normalizeAutoRefreshMinutes(minutes);
    this.data.autoRefreshMinutes = n;
    this.save();
    return n;
  }

  /** 设置/修改管理口令（先过强度校验），明文落盘 */
  setAdminPassword(pw) {
    const err = validateAdminPassword(pw);
    if (err) fail(err);
    this.data.adminPassword = String(pw);
    this.save();
  }

  listSubs() {
    const out = [];
    for (const p of this.data.products) {
      const account = this.getAccount(p.accountId);
      for (const s of p.subs || []) {
        out.push({ key: `${p.id}-${s.id}`, product: p, sub: s, account });
      }
    }
    return out;
  }

  findSub(key) {
    return this.listSubs().find((e) => e.key === key) || null;
  }
}

export const store = new Store();
