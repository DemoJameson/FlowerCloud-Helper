/**
 * 花云（WHMCS + V2raySocks）页面解析
 *
 * 只做两件事：
 *   1. 从客户中心列表页解析出各套餐（id / 名称 / 到期时间）
 *   2. 从套餐详情页解析出该套餐下的各订阅链接（名称 + 地址）
 *
 * 页面结构来自实际抓取，不依赖任何 HTML 解析库 —— 结构固定，正则够用且零依赖。
 */

/** HTML 实体解码（订阅地址里的 &amp; 必须还原，否则地址是坏的） */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/**
 * 解析套餐列表。
 * 结构：<a class="card-row" href="clientarea.php?action=productdetails&id=409808">
 *       <span class="cell-title">Global Acceleration Lite</span>
 *       ...<span class="text-muted">到期时间: </span>2027-10-01
 */
export function parseProducts(html) {
  const text = decodeEntities(html);
  const out = [];
  const seen = new Set();

  // 一次匹配一个 <li>…</li> 块，避免跨越套餐串位
  const blocks = text.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const href = /href\s*=\s*["']([^"']*action=productdetails[^"']*)["']/i.exec(block);
    if (!href) continue;

    let id = '';
    try {
      id = new URL(href[1], 'https://x.invalid').searchParams.get('id') || '';
    } catch {
      const m = /[?&]id=(\d+)/i.exec(href[1]);
      if (m) id = m[1];
    }
    if (!/^\d+$/.test(id) || seen.has(id)) continue;

    const title = /class\s*=\s*["'][^"']*cell-title[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(block);
    const name = title ? cleanText(title[1]) : '';

    // 到期时间：<span class="text-muted">到期时间: </span>2027-10-01
    let expire = '';
    const exp = /(?:到期时间|到期|Expires?)\s*[:：]?\s*<\/span>\s*([\d]{4}-[\d]{2}-[\d]{2})/i.exec(block);
    if (exp) expire = exp[1];

    seen.add(id);
    out.push({ id, name: name || `套餐 ${id}`, expire });
  }

  // 兜底：若 <li> 切分失败（有些模板不闭合 li），退回按 href 逐个扫
  if (!out.length) {
    const re = /href\s*=\s*["']([^"']*action=productdetails[^"']*)["']/gi;
    let m;
    while ((m = re.exec(text))) {
      let id = '';
      try {
        id = new URL(m[1], 'https://x.invalid').searchParams.get('id') || '';
      } catch {
        const im = /[?&]id=(\d+)/i.exec(m[1]);
        if (im) id = im[1];
      }
      if (!/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: `套餐 ${id}`, expire: '' });
    }
  }

  return out;
}

/**
 * 解析套餐详情页里的订阅链接。
 * 结构：<div class="subscription-item">
 *        <div class="subscription-info">
 *          <span class="subscription-name">Clash</span>
 *          <span class="subscription-desc">[...]</span>
 *        </div>
 *        <div class="subscription-actions">
 *          <button class="copy-btn primary" data-copy="https://...">复制</button>
 *
 * 注意：页面里被 HTML 注释掉的条目（<!-- … -->）不是有效订阅，必须跳过 ——
 * 花云模板里有 Clash 兼容订阅、Quantumult 等一批注释掉的备用链接。
 */
export function parseSubscriptions(html) {
  const text = decodeEntities(html);

  // 先摘掉注释，避免把注释掉的条目当成真的
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');

  const out = [];
  const seen = new Set();
  const blocks = stripped.match(/<div\b[^>]*subscription-item[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];

  const collect = (block) => {
    const nameEl = /class\s*=\s*["'][^"']*subscription-name[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(block);
    const name = nameEl ? cleanText(nameEl[1]) : '';

    // 取 data-copy 的值；qr-btn 的 data-qr-content 是同一个地址的副本，取 copy 即可
    const copies = [...block.matchAll(/data-copy\s*=\s*["']([^"']+)["']/gi)];
    for (const c of copies) {
      const url = c[1].trim();
      if (!/^https?:\/\//i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ name: name || `订阅 ${out.length + 1}`, url });
      // 一个 item 通常只有一个 copy 按钮，取第一个即可
      break;
    }
  };

  for (const b of blocks) collect(b);

  // 兜底：结构变化时，直接扫 data-copy，并用最近的 subscription-name 补名
  if (!out.length) {
    const items = stripped.split(/subscription-item/i);
    for (const seg of items.slice(1)) {
      const short = seg.slice(0, 2000);
      const n = /subscription-name[^>]*>([\s\S]*?)<\//i.exec(short);
      const c = /data-copy\s*=\s*["']([^"']+)["']/i.exec(short);
      if (!c) continue;
      const url = c[1].trim();
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ name: n ? cleanText(n[1]) : `订阅 ${out.length + 1}`, url });
    }
  }

  return out;
}

/** 提取标签内的文本并压缩空白 */
function cleanText(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 登录后判断是否真的进了客户中心（密码框消失） */
export function loginSucceeded(html) {
  return !/input[^>]*type\s*=\s*["']?password/i.test(html);
}

/** 登录页上的错误提示 */
export function loginError(html) {
  const m =
    /(?:alert-danger|alert-error|class="error"|id="loginError")[^>]*>([\s\S]{0,300}?)</i.exec(
      String(html ?? '')
    );
  return m ? cleanText(m[1]) : '';
}

/**
 * 从登录页解析表单的提交地址。
 *
 * 真实花云的登录表单 action 是 /dologin.php（不是 /clientarea.php！）——
 * 之前硬编码 POST 到 /clientarea.php，表单提交给了展示页，
 * 密码再对也只会被当成普通浏览，登录永远失败。
 * 这里直接从页面里读 action，面板模板怎么改都不用动代码。
 */
export function loginFormAction(html, baseUrl) {
  const text = String(html ?? '');
  // 找包含密码输入框的那个 form
  const forms = text.match(/<form\b[\s\S]*?<\/form>/gi) || [];
  for (const form of forms) {
    if (!/type\s*=\s*["']?password/i.test(form)) continue;
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(form);
    const raw = action ? action[1].trim() : '';
    try {
      return new URL(raw || 'clientarea.php', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
    } catch {
      return clientAreaOf(baseUrl);
    }
  }
  // 没找到带密码框的 form（可能页面结构不同），退回客户中心地址
  return clientAreaOf(baseUrl);
}

function clientAreaOf(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '') + '/clientarea.php';
}

/** 登录页里的 CSRF token 隐藏域（兼容 name/value 属性顺序颠倒的写法） */
export function loginToken(html) {
  const inputs = String(html ?? '').match(/<input\b[^>]*>/gi) || [];
  for (const tag of inputs) {
    const name = /name\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!name || name[1].toLowerCase() !== 'token') continue;
    const value = /value\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (value) return value[1];
  }
  return '';
}