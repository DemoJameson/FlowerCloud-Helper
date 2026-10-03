/**
 * 节点域名替换的回归测试。
 * 样例结构取自机场真实下发的 6 种客户端配置，存于 test/fixtures/hosts
 * （由 test/fixtures/make-hosts-fixture.mjs 从桌面「花云」目录裁剪生成，
 *  节点域名 / SNI / 密码 / 订阅 token 全部占位化，不含真实基础设施信息）。
 * 若桌面目录存在，则优先用真实配置做全量验证。
 *   node test/hostmap.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteHostDomains, parseManualMap } from '../src/hostmap.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
};

/* ---------------- 真实样例：6 种客户端格式 ---------------- */

const sampleDirs = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/hosts'),
  // 桌面「花云」目录里有机场真实下发的 6 种配置，存在时拿来做全量验证
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Desktop/花云'),
];
const samples = [
  ['Clash.yaml', /proxies:/],
  ['Surge.conf', /^\[Proxy\]/m],
  ['Surfboard.conf', /^\[Proxy\]/m],
  ['Loon.conf', /^\[Proxy\]/m],
  ['Shadowrocket.conf', /^\[Proxy\]/m],
  ['Quantumult X.txt', /^\[server_local\]/m],
];

for (const [file, marker] of samples) {
  const p = sampleDirs.map((d) => path.join(d, file)).find((x) => existsSync(x));
  if (!p) {
    console.log(`SKIP  ${file}（样例不存在，跳过）`);
    continue;
  }
  const src = readFileSync(p, 'utf8');
  const out = rewriteHostDomains(src);
  // 占位 / 真域名由该文件自己的映射推断，测试不硬编码任何域名
  const [fakes, reals] = [
    out.pairs.map(([k]) => k),
    out.pairs.map(([, v]) => v),
  ];

  check(`${file} 识别出映射`, out.pairs.length > 0, `${out.pairs.length} 条`);
  check(
    `${file} 节点已换成真域名`,
    fakes.every((d) => !out.body.includes(d)),
    `残留 ${fakes.reduce((n, d) => n + countOf(out.body, d), 0)} 处`
  );
  check(`${file} 真域名已写入`, reals.some((d) => out.body.includes(d)));
  check(`${file} 格式未破坏`, marker.test(out.body));

  // 只删映射条目、其余原样：行数减少量应恰好等于映射条数（Clash 删空时多删键名一行）
  const srcLines = lineCount(src);
  const outLines = lineCount(out.body);
  const removed = srcLines - outLines;
  check(
    `${file} 只删了 hosts 映射行`,
    removed === out.pairs.length || removed === out.pairs.length + 1,
    `删 ${removed} 行 / ${out.pairs.length} 条映射`
  );

  // 替换处数应等于「原文中占位域名出现次数 - hosts 段里的映射条数」
  const inSrc = fakes.reduce((n, d) => n + countOf(src, d), 0);
  const expect = inSrc - out.pairs.length;
  check(`${file} 替换处数与原文一致`, out.count === expect, `${out.count} 处（预期 ${expect}）`);

  // 再跑一次不应再改动（真域名不是任何映射的 key）
  check(`${file} 幂等`, rewriteHostDomains(out.body).count === 0);
}

/* ---------------- 通用订阅：不该被碰 ---------------- */

const plainClash = `port: 7890
proxies:
  - {name: "HK 1", server: hk1.example.com, port: 443, type: trojan, password: pw}
proxy-groups:
  - {name: PROXY, type: select, proxies: ["HK 1"]}
rules:
  - MATCH,PROXY
`;
const plainOut = rewriteHostDomains(plainClash);
check('通用 Clash 订阅原样返回', plainOut.body === plainClash && plainOut.count === 0);
check('通用 Clash 不产生映射', plainOut.pairs.length === 0);

const plainSurge = `[General]
loglevel = notify

[Proxy]
HK = trojan, hk1.example.com, 443, password=pw
`;
check('通用 Surge 订阅原样返回', rewriteHostDomains(plainSurge).body === plainSurge);

/* ---------------- hosts 段里非域名映射要保留 ---------------- */

const withDns = `[Host]
doh.pub = server:119.29.29.29
router.asus.com = server:system
*.lan = server:system
aaa.placeholder-a.example.com = bbb.real-a.example.net

[Proxy]
HK = trojan, aaa.placeholder-a.example.com, 443, password=pw
`;
const dnsOut = rewriteHostDomains(withDns);
check('DNS 分流项原样保留', dnsOut.body.includes('doh.pub = server:119.29.29.29'));
check('server:system 项原样保留', dnsOut.body.includes('router.asus.com = server:system'));
check('通配符项原样保留', dnsOut.body.includes('*.lan = server:system'));
check('仅域名映射被删', !dnsOut.body.includes('aaa.placeholder-a.example.com = bbb.real-a.example.net'));
check('节点域名已替换', dnsOut.body.includes('trojan, bbb.real-a.example.net, 443'));

/* ---------------- hosts 段删空后键名也清掉 ---------------- */

const onlyHosts = `proxies:
  - {name: "HK", server: a.placeholder-a.example.com, port: 443, type: trojan, password: pw}
hosts:
  a.placeholder-a.example.com: b.real-a.example.net
rules:
  - MATCH,DIRECT
`;
const onlyOut = rewriteHostDomains(onlyHosts);
check('Clash hosts: 键名随内容一起删除', !/^hosts:/m.test(onlyOut.body), JSON.stringify(onlyOut.body));
check('Clash 节点已替换', onlyOut.body.includes('server: b.real-a.example.net'));

/* ---------------- 机场自带的 hosts 不能被误删 ---------------- */

const mixed = `hosts:
  a.placeholder-a.example.com: b.real-a.example.net
  keep.me.com: 1.2.3.4
rules:
  - MATCH,DIRECT
`;
const mixedOut = rewriteHostDomains(mixed);
check('hosts 里其它条目保留', mixedOut.body.includes('keep.me.com: 1.2.3.4'));
check('hosts: 键名因仍非空而保留', /^hosts:/m.test(mixedOut.body));

/* ---------------- 值是 IP 的映射不算数 ---------------- */

const ipHost = `hosts:
  x.placeholder-a.example.com: 1.2.3.4
rules:
  - MATCH,DIRECT
`;
const ipOut = rewriteHostDomains(ipHost);
check('IP 值不算域名映射，原样返回', ipOut.body === ipHost && ipOut.count === 0);

/* ---------------- 前缀包含关系不互相吃掉 ---------------- */

const prefix = `hosts:
  a.placeholder-a.example.com: long.real-a.example.net
  sub.a.placeholder-a.example.com: short.real-a.example.net
rules:
  - MATCH,DIRECT
`;
const prefixOut = rewriteHostDomains(prefix);
check(
  '长域名优先替换',
  prefixOut.body.includes('sub.a.placeholder-a.example.com: short.real-a.example.net') &&
    prefixOut.body.includes('a.placeholder-a.example.com: long.real-a.example.net')
);

/* ---------------- CRLF 保持 ---------------- */

const crlf = '[Proxy]\r\nHK = trojan, a.placeholder-a.example.com, 443, password=pw\r\n';
const crlfOut = rewriteHostDomains(crlf);
check('CRLF 行尾不被改成 LF', crlfOut.body.includes('\r\n') && !/[^\r]\n/.test(crlfOut.body));

/* ---------------- base64 订阅 + 手动映射 ---------------- */

const b64Nodes = ['ss://YWVzLTI1Ni1nY206cHc@a.placeholder-a.example.com:8388#HK', 'ss://YWVzLTI1Ni1nY206cHc@c.placeholder-a.example.com:8388#JP'].join(
  '\n'
);
const b64 = Buffer.from(b64Nodes, 'utf8').toString('base64');
check('base64 无手动映射时原样返回', rewriteHostDomains(b64).body === b64);

const b64Out = rewriteHostDomains(b64, 'a.placeholder-a.example.com=1.real-a.example.net, c.placeholder-a.example.com=2.real-a.example.net');
const decoded = Buffer.from(b64Out.body, 'base64').toString('utf8');
check('base64 订阅被替换', decoded.includes('1.real-a.example.net:8388') && decoded.includes('2.real-a.example.net:8388'), decoded.split('\n')[0]);
check('base64 结构仍是合法 base64', /^[A-Za-z0-9+/]+={0,2}$/.test(b64Out.body));

check('手动映射解析', parseManualMap(' a.com=b.com , c.d=e.f ').get('c.d') === 'e.f');
check('手动映射忽略非法项', parseManualMap('a.com=, =b.com, 1.2.3.4=x.com').size === 0);

/* ---------------- 边界输入 ---------------- */

check('空字符串', rewriteHostDomains('').count === 0);
check('undefined', rewriteHostDomains(undefined).body === undefined);
check('非字符串', rewriteHostDomains(123).body === 123);
check('空 body', rewriteHostDomains('   \n  ').count === 0);

function countOf(text, sub) {
  return text.split(sub).length - 1;
}
function lineCount(text) {
  return text.split('\n').length;
}

console.log(`\n=== ${pass}/${pass + fail} 通过 ===`);
process.exit(fail ? 1 : 0);
