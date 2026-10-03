/**
 * 订阅内容实时回源
 *
 * 客户端每次请求 /sub 都实时回源拉取，不做缓存 ——
 * 订阅内容是别人家服务器生成的，转发即可；subscription-userinfo 响应头
 * 也原样返回，套餐级的流量落库由调用方做（见 state.js 的 syncTrafficFromSubFetch）。
 */
import { config } from './config.js';
import { rewriteHostDomains } from './hostmap.js';
import { log } from './logtime.js';

/** 调用方没带 UA 时的兜底：订阅站会按 UA 改变返回，用一个常见客户端 UA 更稳 */
export const DEFAULT_SUBSCRIPTION_UA = 'clash-verge/2.5.7';

function detectContentType(body) {
  if (/proxies:|proxy-groups:|proxy-providers:/i.test(body)) return 'text/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/**
 * 上游给的文件名（Content-Disposition）。
 *
 * 机场的转换站（subconverter 系）会给响应加
 *   Content-Disposition: attachment; filename=Flower_SS.yaml
 * 浏览器据此触发下载；没有这个头时，浏览器会把 YAML 当网页文本内联渲染出来。
 * 我们是转发上游，不补这个头就会「原地址能下载、我们的地址只能看」。
 *
 * 优先沿用上游响应头的真实文件名；拿不到就从订阅 URL 的 `filename` 参数推断
 * （subconverter 约定），再按 `target` 兜底推一个合适的扩展名。
 */
function resolveFilename(url, upstreamDisposition) {
  // 上游已给出且是 attachment：原样沿用
  if (upstreamDisposition && /attachment/i.test(upstreamDisposition)) {
    return upstreamDisposition;
  }

  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }

  const target = (params.get('target') || '').toLowerCase();
  // 扩展名按目标客户端给，浏览器据此选打开方式
  const extByTarget = {
    clash: '.yaml',
    clashmeta: '.yaml',
    mihomo: '.yaml',
    surge: '.conf',
    surfboard: '.conf',
    shadowrocket: '.conf',
    loon: '.conf',
    quanx: '.conf',
    quantumultx: '.conf',
    singbox: '.json',
    v2ray: '.txt',
  };

  // filename 可能带路径或非法字符：只取末段，并清掉空白/引号/分号/反斜杠
  // （中间的空格也要清 —— Content-Disposition 里带空格会让部分客户端解析异常）
  const raw = params.get('filename') || '';
  const last = raw.split(/[/\\]/).pop() || '';
  let safe;
  try {
    safe = decodeURIComponent(last).replace(/[\s"'\\;]/g, '');
  } catch {
    safe = last.replace(/[\s"'\\;]/g, '');
  }

  if (safe && /\.[A-Za-z0-9]{1,8}$/.test(safe)) {
    return `attachment; filename="${safe}"`;
  }
  return `attachment; filename="subscription${extByTarget[target] || '.txt'}"`;
}

/**
 * 把订阅正文里的「占位域名」换成真实入口域名（见 hostmap.js）。
 * 没配置映射、或正文里没有这类映射时原样返回，因此通用订阅零影响。
 */
function applyHostRewrite(body, entry) {
  if (config.hostRewrite === 'off') return body;
  try {
    const out = rewriteHostDomains(body, config.hostMap);
    if (out.count) {
      log(
        `[sub] ${entry?.product?.name || entry?.key || '?'} 域名替换 ${out.count} 处` +
          `（${out.pairs.map(([k, v]) => `${k}→${v}`).join(', ')}）`
      );
    }
    return out.body;
  } catch (e) {
    // 改写失败不能连累订阅本身：原样转发，客户端仍可用 hosts 连
    log('[sub] 域名替换失败，原样转发:', e?.message || e);
    return body;
  }
}

/**
 * 实时拉一条订阅内容。
 * @param {{ key:string, product:object, account:{baseUrl?:string}, sub:{url:string} }} entry
 * @param {string} [userAgent] 调用方（订阅客户端）的 UA，原样转发给上游；缺省用兜底 UA
 * @returns {{ body:string, userInfo:string|null, contentType:string, disposition:string|null }}
 */
export async function fetchSubscription(entry, userAgent) {
  const url = entry.sub.url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.SUB_TIMEOUT_MS || 60000));

  try {
    const headers = {
      'user-agent': userAgent || DEFAULT_SUBSCRIPTION_UA,
      accept: '*/*',
      // 花云的订阅站有时校验 referer，带上订阅所属账号的机场地址（兜底 BASE_URL）
      referer: (entry.account?.baseUrl || config.baseUrl || 'https://api-flowercloud.com/') + '/',
    };
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`订阅地址返回 ${res.status}，可能已失效，请到仪表盘点「刷新全部」重新抓取`);
    }
    if (!res.ok) {
      // 转换站对「上游无有效节点」返回 400 + 原因说明，把这个提示带给用户 ——
      // 最常见的原因是订阅开关没打开或上游 token 已重置，重新「刷新全部」即可
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
      const hint = /valid node info/i.test(detail)
        ? '（转换站说上游没有有效节点：通常是订阅开关未打开或上游订阅已重置，点「刷新全部」重新激活抓取即可）'
        : '';
      throw new Error(`订阅地址返回 HTTP ${res.status}${hint}${detail ? '：' + detail : ''}`);
    }

    const body = await res.text();
    if (!body.trim()) throw new Error('订阅地址返回了空内容');

    return {
      body: applyHostRewrite(body, entry),
      userInfo: res.headers.get('subscription-userinfo'),
      contentType: detectContentType(body),
      // 浏览器直接打开订阅地址时能触发下载，而不是把 YAML 内联渲染出来
      disposition: resolveFilename(url, res.headers.get('content-disposition')),
    };
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`拉取订阅超时（${Number(process.env.SUB_TIMEOUT_MS || 60000) / 1000} 秒）`, {
        cause: e,
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}