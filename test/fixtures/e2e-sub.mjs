/**
 * 端到端验证：起一个假订阅上游（返回桌面真实 Clash.yaml），
 * 走 fetchSubscription 完整链路，确认客户端拿到的就是替换后的配置。
 *   node test/fixtures/e2e-sub.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Desktop/花云');
if (!existsSync(path.join(dir, 'Clash.yaml'))) {
  console.log('桌面「花云」样例不存在，跳过');
  process.exit(0);
}
const upstream = readFileSync(path.join(dir, 'Clash.yaml'), 'utf8');

const { fetchSubscription } = await import('../../src/fetchsub.js');

const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/yaml' });
  res.end(upstream);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const entry = {
  key: 'e2e',
  product: { id: 'p1', name: 'E2E 套餐', accountId: 'a1' },
  account: { baseUrl: 'https://api-flowercloud.com' },
  sub: { url: `http://127.0.0.1:${port}/sub?target=clash`, token: 't' },
};

const out = await fetchSubscription(entry, 'clash-verge/2.5.7');
srv.close();

// 域名从 hostmap 的映射结果推断，本脚本不硬编码任何机场标识
const { rewriteHostDomains } = await import('../../src/hostmap.js');
const pairs = rewriteHostDomains(upstream).pairs;
const countAll = (text, ds) => ds.reduce((n, d) => n + text.split(d).length - 1, 0);
const fakes = pairs.map(([k]) => k);
const reals = pairs.map(([, v]) => v);

const fake = countAll(out.body, fakes);
const real = countAll(out.body, reals);
const nodes = (out.body.match(/^ {2}- \{name:/gm) || []).length;
const srcNodes = (upstream.match(/^ {2}- \{name:/gm) || []).length;
const rules = (out.body.match(/^ - /gm) || []).length;
const srcRules = (upstream.match(/^ - /gm) || []).length;
const hasHosts = /^hosts:/m.test(out.body);
const passwordsIntact = !fakes.some((d) => new RegExp(`password[:=]\\s*"?${d.replace(/\./g, '\\.')}`, 'i').test(out.body));

const checks = [
  ['占位域名已清零', fake === 0, `${fake} 处`],
  ['真域名已写入', real > 80, `${real} 处`],
  ['节点数不变', nodes === srcNodes, `${nodes} 个`],
  ['规则数不变', rules === srcRules, `${rules} 条`],
  ['hosts 段已移除', !hasHosts, hasHosts ? '仍在' : '已移除'],
  ['proxies 段保留', /^proxies:/m.test(out.body)],
  ['contentType 仍为 yaml', out.contentType.includes('yaml'), out.contentType],
  ['下载文件名保留', /attachment/.test(out.disposition || ''), out.disposition],
  ['password 未被改写', passwordsIntact],
];

let bad = 0;
for (const [name, ok, detail = ''] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}
console.log(`\n节点 server 样例: ${out.body.split('\n').find((l) => /server:/.test(l))?.slice(0, 130)}`);
process.exit(bad ? 1 : 0);
