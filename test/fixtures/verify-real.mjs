/**
 * 拿桌面「花云」目录里机场真实下发的 6 份完整配置做一次性端到端验证。
 * 不进 npm test（依赖桌面目录），改完 hostmap.js 想复验时手动跑：
 *   node test/fixtures/verify-real.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteHostDomains } from '../../src/hostmap.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Desktop/花云');
const files = ['Clash.yaml', 'Surge.conf', 'Surfboard.conf', 'Loon.conf', 'Shadowrocket.conf', 'Quantumult X.txt'];

if (!existsSync(dir)) {
  console.log('桌面「花云」目录不存在，跳过');
  process.exit(0);
}

let bad = 0;
for (const f of files) {
  const p = path.join(dir, f);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  const out = rewriteHostDomains(src);
  // 域名从映射本身推断，脚本不硬编码任何机场标识
  const fakes = out.pairs.map(([k]) => k);
  const reals = out.pairs.map(([, v]) => v);
  const count = (text, ds) => ds.reduce((n, d) => n + text.split(d).length - 1, 0);
  const fakeLeft = count(out.body, fakes);
  const realCount = count(out.body, reals);
  const ok = fakeLeft === 0 && out.count > 0 && out.pairs.length > 0;
  if (!ok) bad++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(20)} ` +
      `${String(src.length).padStart(7)}B → ${String(out.body.length).padStart(7)}B  ` +
      `映射 ${out.pairs.length} 条，替换 ${out.count} 处，残留占位 ${fakeLeft} 处，真域名 ${realCount} 处`
  );
  if (!ok) console.log(`        映射: ${JSON.stringify(out.pairs)}`);
}
process.exit(bad ? 1 : 0);
