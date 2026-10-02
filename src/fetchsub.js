/**
 * 订阅内容实时回源
 *
 * 客户端每次请求 /sub 都实时回源拉取，不做缓存 ——
 * 订阅内容是别人家服务器生成的，转发即可；subscription-userinfo 响应头
 * 也原样返回，套餐级的流量落库由调用方做（见 state.js 的 syncTrafficFromSubFetch）。
 */
import { config } from './config.js';

/** 调用方没带 UA 时的兜底：订阅站会按 UA 改变返回，用一个常见客户端 UA 更稳 */
export const DEFAULT_SUBSCRIPTION_UA = 'clash-verge/2.5.7';

function detectContentType(body) {
  if (/proxies:|proxy-groups:|proxy-providers:/i.test(body)) return 'text/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/**
 * 实时拉一条订阅内容。
 * @param {{ key:string, product:object, account:{baseUrl?:string}, sub:{url:string} }} entry
 * @param {string} [userAgent] 调用方（订阅客户端）的 UA，原样转发给上游；缺省用兜底 UA
 * @returns {{ body:string, userInfo:string|null, contentType:string }}
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
      body,
      userInfo: res.headers.get('subscription-userinfo'),
      contentType: detectContentType(body),
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