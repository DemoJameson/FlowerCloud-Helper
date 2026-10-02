/**
 * 假花云面板（复刻真实页面结构），用于本地验收。
 *
 *   node test/mock-panel.mjs
 *
 * 监听 9101，页面结构照着 api-flowercloud.com 复刻：
 *   /clientarea.php                登录页 / 登录后是套餐列表
 *   /clientarea.php?action=productdetails&id=xxx   套餐详情（含订阅链接）
 *
 * 账号：main@demo.local / demo123、backup@demo.local / demo456、
 *       expired@demo.local / demo000（仅提供多账号联调，没有「已过期」特殊逻辑）
 * 每个套餐下挂多种协议的订阅链接，并故意保留一段被 HTML 注释的条目，
 * 用来验证「注释掉的条目不能被抓到」。
 */
import http from 'node:http';

const log = (...a) => console.log(new Date().toISOString(), ...a);

const PRODUCTS = [
  {
    id: '409808',
    name: 'Global Acceleration Lite',
    expire: '2027-10-01',
    // token2 为合成占位（8 位前缀-24 位后缀），与任何真实凭据无关；
    // /sub 端点按前 10 位匹配套餐，两个套餐的前缀必须不同
    token2: 'mockaaaa1-aaaaaaaaaaaaaaaaaaaa',
  },
  {
    id: '409809',
    name: 'Global Acceleration Pro',
    expire: '2028-01-15',
    token2: 'mockaaaa2-bbbbbbbbbbbbbbbbbbbb',
  },
];

const ACCOUNTS = [
  { id: 'main', email: 'main@demo.local', password: 'demo123' },
  { id: 'backup', email: 'backup@demo.local', password: 'demo456' },
  { id: 'expired', email: 'expired@demo.local', password: 'demo000' },
];

// 本地 mock 不能用真实面板/订阅域名（本地不存在），统一指向 mock 自己的
// 订阅端点，这样 /sub 接口能真正拉通。
const MOCK_ORIGIN = 'http://host.docker.internal:9101';
const SUB_PATH = '/sub?target=clash&url=' + encodeURIComponent(MOCK_ORIGIN + '/sub?token2=');

const sessions = new Set();

// 模拟 V2raySocks「订阅开关」：ActivateSublink 激活后 45 秒内 /sub 才出节点，
// 过期就返回转换站同款 400 —— 用于端到端验证 helper 的「刷新授权」自愈。
const ACTIVATION_TTL_MS = 45_000;
const activatedAt = new Map(); // productId → ts

/* ------------------------------------------------------------------ */
/* 页面模板                                                            */
/* ------------------------------------------------------------------ */

function loginPage(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>客户中心 - 花云</title></head><body>
<h1>花云 客户中心</h1>
${message ? `<div class="alert alert-danger">${message}</div>` : ''}
<form method="post" action="/dologin.php" class="c-login__content" role="form">
  <input type="hidden" name="token" value="mock-csrf-token">
  <input type="email" name="username" class="c-input" id="inputEmail" placeholder="请输入邮箱">
  <input type="password" name="password" class="c-input" id="inputPassword" placeholder="请输入密码">
  <button class="c-btn c-btn--info c-btn--fullwidth" type="submit">登录</button>
</form>
</body></html>`;
}

/** 套餐列表：结构照真实花云 —— <li><a class="card-row" href="...productdetails&id=..."> */
function listPage(account) {
  const rows = PRODUCTS.map(
    (p) => `
  <li>
    <a class="card-row" href="clientarea.php?action=productdetails&amp;id=${p.id}">
      <span class="cell-title">${p.name}</span>
      <span class="cell-cycle">
        <span class="text-muted"></span>
      </span>
      <span class="cell-license">
        <span class="text-muted">到期时间: </span>
        ${p.expire}
      </span>
    </a>
  </li>`
  ).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>客户中心 - 花云</title></head><body>
<h1>我的产品</h1>
<p>账号：${account.email}</p>
<ul class="list products">
${rows}
</ul>
</body></html>`;
}

/** 套餐详情：结构照真实花云 —— .subscription-item + .subscription-name + .copy-btn[data-copy] */
function productPage(account, product) {
  const t = product.token2;
  const ss = encodeURIComponent(`${MOCK_ORIGIN}/sub?token2=${t}&sip002=1`);

  const item = (name, desc, url) => `
        <div class="subscription-item">
          <div class="subscription-info">
            <span class="subscription-name">${name}</span>
            <span class="subscription-desc">${desc}</span>
          </div>
          <div class="subscription-actions">
            <button class="copy-btn primary" data-copy="${url}">复制</button>
          </div>
        </div>`;

  const items = [
    item(
      'Clash',
      '[适用于 FlClash / Clash Verge / Stash 等客户端的订阅链接]',
      `${MOCK_ORIGIN}${SUB_PATH}${encodeURIComponent(`token2=${t}&sip002=1`)}&amp;insert=true&amp;filename=Flower_SS.yaml`
    ),
    item(
      'Trojan Clash',
      '[适用于 FlClash / Clash Verge / Stash 等客户端的订阅链接]<br>* Trojan协议在特定网络环境下会提供更好的体验',
      `${MOCK_ORIGIN}${SUB_PATH}${encodeURIComponent(`token2=${t}`)}&amp;filename=Flower_Trojan.yaml`
    ),
    item(
      'Surge',
      '[适用于 Surge iOS / macOS 的托管订阅链接]',
      `${MOCK_ORIGIN}/sub?target=surge&amp;ver=4&amp;filename=Flower_SS.conf&amp;url=${ss}`
    ),
    item(
      'Quantumult X',
      '[适用于 Quantumult X 的订阅链接，默认为托管订阅]',
      `${MOCK_ORIGIN}/sub?target=quanx&amp;url=${ss}`
    ),
    item('Shadowsocks SIP002 通用订阅 ', '[SS SIP002 订阅链接，适用于 PassWall / SSRPlus+ 等软路由订阅插件]',
      `${MOCK_ORIGIN}/sub?token2=${t}&amp;sip002=1`),
    item('Trojan 通用订阅', '[Trojan 通用订阅链接，适用于 PassWall / SSRPlus+ 等软路由订阅插件]',
      `${MOCK_ORIGIN}/sub?token2=${t}`),
  ].join('');

  // 故意放一段被注释的条目：解析时必须跳过
  const commented = `
        <!--
        <div class="subscription-item">
          <div class="subscription-info">
            <span class="subscription-name">Quantumult</span>
            <span class="subscription-desc">[注释掉的条目，不应被抓到]</span>
          </div>
          <div class="subscription-actions">
            <button class="copy-btn primary" data-copy="https://example.invalid/COMMENTED_SHOULD_BE_SKIPPED">复制</button>
          </div>
        </div>
        -->`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>产品详情 - 花云</title></head><body>
<h1>${product.name}</h1>
<p>账号：${account.email} ｜ 套餐 ID：${product.id} ｜ 到期：${product.expire}</p>
<button class="btn btn-info" id="activate_sub">打开订阅更新开关</button>
<p class="status">订阅更新开关：已开启</p>
<div class="subscription-list">
${items}
${commented}
</div>
</body></html>`;
}


/** 订阅内容端点：模拟真实转换站 / 上游订阅站的行为 */
function subscriptionBody(token2, product) {
  const name = product ? product.name : 'FlowerCloud';
  return [
    'proxies:',
    `  - name: "${name}-01"`,
    '    type: ss',
    '    server: 1.2.3.4',
    '    port: 443',
    '    cipher: aes-128-gcm',
    '    password: mock-' + token2.slice(0, 8),
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - ${name}-01`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:9101');
  const path = url.pathname;
  const account = ACCOUNTS.find((a) => a.id === cookies(req).mocksess) || null;
  const html = (body, code = 200) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  // 登录
  if (path === '/dologin.php' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const email = body.get('username');
    const password = body.get('password');
    const hit = ACCOUNTS.find((a) => a.email === email && a.password === password);
    log(`[mock] 登录尝试 ${email} -> ${hit ? '成功' : '失败'}`);
    if (!hit) return html(loginPage('账户或密码错误，请重试。'));
    sessions.add(hit.id);
    res.writeHead(302, {
      location: '/clientarea.php',
      'set-cookie': `mocksess=${hit.id}; Path=/; HttpOnly`,
    });
    return res.end();
  }

  // 登出（WHMCS 标准端点）：清掉会话 cookie
  if (path === '/logout.php') {
    sessions.delete(cookies(req).mocksess);
    res.writeHead(302, {
      location: '/clientarea.php',
      'set-cookie': 'mocksess=; Path=/; HttpOnly; Max-Age=0',
    });
    return res.end();
  }

  // V2raySocks 激活订阅开关：激活后 ACTIVATION_TTL_MS 内 /sub 才出节点
  if (path === '/clientarea.php' && url.searchParams.get('V2raySocksAction') === 'ActivateSublink') {
    if (!account) return html(loginPage(''), 401);
    const pid = url.searchParams.get('Serviceid') || url.searchParams.get('id');
    activatedAt.set(pid, Date.now());
    log(`[mock] 订阅开关已激活 pid=${pid}（${ACTIVATION_TTL_MS / 1000}s 后过期）`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ activated: 200 }));
  }

  // 套餐列表（仅 GET；POST 到这里不是登录，不该当成已登录）
  if (path === '/clientarea.php' && req.method === 'GET' && url.searchParams.get('action') !== 'productdetails') {
    if (!account) return html(loginPage(''));
    return html(listPage(account));
  }

  // 套餐详情
  if (path === '/clientarea.php' && url.searchParams.get('action') === 'productdetails') {
    if (!account) return html(loginPage(''));
    const id = url.searchParams.get('id');
    const product = PRODUCTS.find((p) => p.id === id);
    if (!product) return html('<h1>找不到该套餐</h1>', 404);
    return html(productPage(account, product));
  }

  // 订阅内容：直接 /sub?token2=xxx，或转换站 /sub?target=...&url=<encoded>
  if (path === '/sub') {
    const target = url.searchParams.get('token2');
    const wrapped = url.searchParams.get('url');
    const real = wrapped ? new URL(wrapped) : url;
    // 页面模板生成的 URL 里 token2 值本身带着 'token2=' 前缀（token2=token2=qdm…），
    // 剥掉它；已落盘的旧订阅 URL 也是这个格式，改解析端可保客户端 token 不失效
    let token2 = target || real.searchParams.get('token2') || '';
    if (token2.startsWith('token2=')) token2 = token2.slice('token2='.length);
    if (!token2) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('missing token2');
    }
    const product = PRODUCTS.find((p) => token2.startsWith(p.token2.slice(0, 10)));
    // 订阅开关过期模拟：未激活或超过 TTL → 与真实转换站一致的 400
    const at = product ? activatedAt.get(product.id) || 0 : 0;
    if (!product || Date.now() - at > ACTIVATION_TTL_MS) {
      log(`[mock] /sub 拒绝：开关未激活或已过期（token2=${token2.slice(0, 10)}…）`);
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end(
        `The following link doesn't contain any valid node info: ${MOCK_ORIGIN}/osubscribe.php?token2=${token2}`
      );
    }
    res.writeHead(200, {
      'content-type': 'text/yaml; charset=utf-8',
      'subscription-userinfo':
        'upload=1073741824; download=9663676416; total=161061273600; expire=1798761600',
      'profile-update-interval': '24',
    });
    return res.end(subscriptionBody(token2, product));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(9101, '0.0.0.0', () => {
  log('[mock] 假花云面板已启动 http://127.0.0.1:9101');
  log('[mock] 账号：');
  for (const a of ACCOUNTS) log(`  ${a.email} / ${a.password}`);
  log(`[mock] 套餐：${PRODUCTS.map((p) => `${p.name}(${p.id})`).join(', ')}`);
});