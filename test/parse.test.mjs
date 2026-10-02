/**
 * 花云页面解析的回归测试。HTML 片段复刻自真实页面结构，
 * 其中域名与 token 均已替换为占位值。
 *   node test/parse.test.mjs
 */
import { parseProducts, parseSubscriptions, decodeEntities, loginFormAction, loginToken } from '../src/flowercloud.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

/* ---------------- 套餐列表 ---------------- */

const listHtml = `
<ul class="list">
  <li>
    <a class="card-row" href="clientarea.php?action=productdetails&amp;id=409808">
      <span class="cell-title">Global Acceleration Lite</span>
      <span class="cell-cycle">
        <span class="text-muted"></span>
      </span>
      <span class="cell-license">
        <span class="text-muted">到期时间: </span>
        2027-10-01
      </span>
    </a>
  </li>
  <li>
    <a class="card-row" href="clientarea.php?action=productdetails&amp;id=409809">
      <span class="cell-title">Global Acceleration Pro</span>
      <span class="cell-license">
        <span class="text-muted">到期时间: </span>
        2028-01-15
      </span>
    </a>
  </li>
</ul>`;

const products = parseProducts(listHtml);
check('解析出 2 个套餐', products.length === 2, String(products.length));
check('套餐 id 正确', products[0]?.id === '409808', products[0]?.id);
check('套餐名称正确', products[0]?.name === 'Global Acceleration Lite', products[0]?.name);
check('到期时间正确', products[0]?.expire === '2027-10-01', products[0]?.expire);
check('第二个套餐 id', products[1]?.id === '409809', products[1]?.id);

/* ---------------- 订阅链接 ---------------- */

// 用户提供的真实 HTML（含被注释掉的条目）
const subHtml = `
<div class="subscription-list">
  <div class="subscription-item">
    <div class="subscription-info">
      <span class="subscription-name">Clash</span>
      <span class="subscription-desc">[适用于 FlClash / Clash Verge / Stash 等客户端的订阅链接]</span>
    </div>
    <div class="subscription-actions">
      <button class="qr-btn" data-qr-title="Clash" data-qr-content="https://sub.example.dev/sub?target=clash&amp;url=Q1"></button>
      <button class="copy-btn primary" data-copy="https://sub.example.dev/sub?target=clash&amp;insert=true&amp;emoji=true&amp;udp=true&amp;clash.doh=true&amp;new_name=true&amp;filename=Flower_SS.yaml&amp;url=https%3A%2F%2Fpanel.example.com%2Fosubscribe.php%3Ftoken2%3Dmockaaaa1-aaaaaaaaaaaaaaaaaaaa%26sip002%3D1">复制</button>
    </div>
  </div>
  <div class="subscription-item">
    <div class="subscription-info">
      <span class="subscription-name">Trojan Clash</span>
      <span class="subscription-desc">[适用于 FlClash 的订阅链接]
      <br>* Trojan协议在特定网络环境下会提供更好的体验</span>
    </div>
    <div class="subscription-actions">
      <button class="copy-btn primary" data-copy="https://sub.example.dev/sub?target=clash&amp;filename=Flower_Trojan.yaml&amp;url=https%3A%2F%2Fpanel.example.com%2Fosubscribe.php%3Ftoken2%3Dmockaaaa1-aaaaaaaaaaaaaaaaaaaa">复制</button>
    </div>
  </div>
  <div class="subscription-item">
    <div class="subscription-info">
      <span class="subscription-name">Shadowsocks SIP002 通用订阅 </span>
      <span class="subscription-desc">[SS SIP002 订阅链接]</span>
    </div>
    <div class="subscription-actions">
      <button class="copy-btn primary" data-copy="https://panel.example.com/osubscribe.php?token2=mockaaaa1-aaaaaaaaaaaaaaaaaaaa&amp;sip002=1">复制</button>
    </div>
  </div>
  <div class="subscription-item">
    <div class="subscription-info">
      <span class="subscription-name">Surge</span>
      <span class="subscription-desc">[适用于 Surge iOS / macOS 的托管订阅链接]</span>
    </div>
    <div class="subscription-actions">
      <button class="copy-btn primary" data-copy="https://sub.example.dev/sub?target=surge&amp;ver=4&amp;filename=Flower_SS.conf&amp;url=https%3A%2F%2Fpanel.example.com%2Fosubscribe.php%3Ftoken2%3Dmockaaaa1-aaaaaaaaaaaaaaaaaaaa%26sip002%3D1">复制</button>
    </div>
  </div>
  <!--
  <div class="subscription-item">
    <div class="subscription-info">
      <span class="subscription-name">Clash 兼容订阅</span>
      <span class="subscription-desc">[仅用于普通订阅不可用的情况]</span>
    </div>
    <div class="subscription-actions">
      <button class="copy-btn primary" data-copy="https://sub.example.dev/SHOULD_NOT_APPEAR">复制</button>
    </div>
  </div>
  -->
</div>`;

const subs = parseSubscriptions(subHtml);
check('解析出 4 条订阅', subs.length === 4, `实际 ${subs.length}：${subs.map((s) => s.name).join(' / ')}`);
check('注释掉的条目被跳过', !subs.some((s) => s.url.includes('SHOULD_NOT_APPEAR')));
check('Clash 名称正确', subs[0]?.name === 'Clash', subs[0]?.name);
check(
  'HTML 实体已还原（&amp; → &）',
  subs[0]?.url.includes('&insert=true') && !subs[0]?.url.includes('&amp;'),
  subs[0]?.url.slice(0, 60)
);
check('名称尾部空格已清理', subs[2]?.name === 'Shadowsocks SIP002 通用订阅', JSON.stringify(subs[2]?.name));
check(
  '通用订阅地址完整',
  subs[2]?.url === 'https://panel.example.com/osubscribe.php?token2=mockaaaa1-aaaaaaaaaaaaaaaaaaaa&sip002=1',
  subs[2]?.url
);

/* ---------------- 边界 ---------------- */

check('空 HTML 不报错', parseProducts('').length === 0 && parseSubscriptions('').length === 0);
check('实体解码正确', decodeEntities('a&amp;b&lt;c') === 'a&b<c');

const dupHtml = `
<div class="subscription-item"><span class="subscription-name">A</span>
<button class="copy-btn" data-copy="https://x.invalid/same">复制</button></div>
<div class="subscription-item"><span class="subscription-name">B</span>
<button class="copy-btn" data-copy="https://x.invalid/same">复制</button></div>`;
check('重复地址去重', parseSubscriptions(dupHtml).length === 1, String(parseSubscriptions(dupHtml).length));

/* ---------------- 登录表单解析 ---------------- */

const loginHtml = `
<form method="post" action="/dologin.php" class="c-login__content" role="form">
  <input type="hidden" name="token" value="csrf-abc123">
  <input type="email" name="username" id="inputEmail" placeholder="请输入邮箱">
  <input type="password" name="password" id="inputPassword" placeholder="请输入密码">
  <button class="c-btn" type="submit">登录</button>
</form>`;

check('登录表单 action 解析为 /dologin.php',
  loginFormAction(loginHtml, 'https://api-flowercloud.com') === 'https://api-flowercloud.com/dologin.php',
  loginFormAction(loginHtml, 'https://api-flowercloud.com'));
check('CSRF token 解析', loginToken(loginHtml) === 'csrf-abc123', loginToken(loginHtml));

// 属性顺序颠倒的写法
const reversed = '<form method="post" action="dologin.php"><input value="tok-999" name="token" type="hidden"><input type="password" name="password"></form>';
check('value 在 name 之前的 token 也能解析', loginToken(reversed) === 'tok-999', loginToken(reversed));
check('相对 action 按机场地址解析',
  loginFormAction(reversed, 'https://api-flowercloud.com') === 'https://api-flowercloud.com/dologin.php',
  loginFormAction(reversed, 'https://api-flowercloud.com'));

// 页面里有多个 form（搜索框等）时，只认带密码框的那个
const multiForm = `
<form action="/search"><input type="text" name="q"></form>
<form action="/dologin.php"><input type="hidden" name="token" value="t2"><input type="password" name="password"></form>`;
check('多表单时选中带密码框的那个',
  loginFormAction(multiForm, 'https://api-flowercloud.com') === 'https://api-flowercloud.com/dologin.php',
  loginFormAction(multiForm, 'https://api-flowercloud.com'));

// 无表单时退回 clientarea.php
check('无登录表单时退回客户中心地址',
  loginFormAction('<div>nothing</div>', 'https://api-flowercloud.com') === 'https://api-flowercloud.com/clientarea.php');

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
process.exit(fail ? 1 : 0);