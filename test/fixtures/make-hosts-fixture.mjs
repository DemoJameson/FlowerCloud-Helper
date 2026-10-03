/**
 * 从桌面「花云」目录的机场真实配置里裁出精简 fixture，存进 test/fixtures/hosts。
 * 保留各客户端 hosts/alias 段与前几条节点，token 与机场域名脱敏。
 *   node test/fixtures/make-hosts-fixture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// test/fixtures → 上溯到用户目录，再进 Desktop/花云
const src = path.resolve(here, '../../../../Desktop/花云');
const dst = path.join(here, 'hosts');

/** 取一段配置：name 为 [name] 段名，或 'yaml:hosts' 表示 Clash 的顶层 hosts: 键 */
function section(text, name) {
  const lines = text.split(/\r?\n/);

  if (name.startsWith('yaml:')) {
    const key = name.slice(5);
    const i = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      // 子项缩进比键名更深；遇到同级或更浅的行即结束
      if (lines[j].trim() && !/^\s+/.test(lines[j])) break;
      out.push(lines[j]);
    }
    return out;
  }

  const i = lines.findIndex((l) => l.trim().toLowerCase() === `[${name}]`);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*\[/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out;
}

/** 节点列表的前 n 条（Clash 取 proxies: 后的行，其余取 [Proxy]/[server_local] 段） */
function proxies(text, n) {
  const lines = text.split(/\r?\n/);
  let start = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  if (start < 0) {
    for (const sec of ['proxy', 'server_local']) {
      start = lines.findIndex((l) => l.trim().toLowerCase() === `[${sec}]`);
      if (start >= 0) break;
    }
    if (start < 0) return [];
    start++;
  } else {
    start++;
  }
  const out = [];
  for (let j = start; j < lines.length; j++) {
    // 只在遇到下一个段头时结束；节点名可能以字母开头（"Traffic: ..."），不能据此中断
    if (/^\s*\[/.test(lines[j])) break;
    if (lines[j].trim()) out.push(lines[j]);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * 机场节点域名 / SNI 同样不入库：它们是机场的基础设施标识，
 * 公开仓库里等于告诉别人这家机场的入口域名长什么样。
 * 按出现顺序稳定映射成假域名，保持「占位域名 ↔ 真实域名」的对应关系不变。
 */
const FAKE_MAP = [
  // [匹配模式, 假域名模板]
  [/[a-z0-9-]+\.aws-agent\.com/gi, 'fake-node-N.example.com'],
  [/[a-z0-9-]+\.apt-agent\.dev/gi, 'real-node-N.example.net'],
  [/[a-z0-9.-]*ctrip\.com/gi, 'sni-N.example.org'],
];

function pseudonymize(s) {
  let out = s;
  for (const [re, tpl] of FAKE_MAP) {
    const seen = new Map();
    out = out.replace(re, (m) => {
      const k = m.toLowerCase();
      if (!seen.has(k)) seen.set(k, tpl.replace('N', String(seen.size)));
      return seen.get(k);
    });
  }
  return out;
}

function sanitize(s) {
  return pseudonymize(s)
    .replace(/token2%3D[A-Za-z0-9-]{6,}/g, 'token2%3DREDACTED')
    .replace(/api-huacloud\.dev/g, 'sub.example.com')
    .replace(/api\.xmancdn\.com/g, 'api.example.com')
    // 节点密码 / 订阅凭据不入库（只替换值本身，保留分隔符以免破坏格式）
    .replace(/(password: )[^\s,}]+/g, '$1REDACTED')
    .replace(/(\bpassword=)[^,\s]+/g, '$1REDACTED')
    // Loon 的 trojan 密码是位置参数：= trojan,host,port,PASSWORD,tls-name:...
    .replace(/(=\s*(?:trojan|ss|vmess|http)(?:-\w+)?,[^,]+,\d+),[^,]+/gi, '$1,REDACTED');
}

const files = existsSync(src)
  ? ['Clash.yaml', 'Surge.conf', 'Loon.conf', 'Surfboard.conf', 'Shadowrocket.conf', 'Quantumult X.txt']
  : [];
if (!files.length) {
  console.log('桌面「花云」样例不存在，跳过生成');
  process.exit(0);
}

mkdirSync(dst, { recursive: true });
for (const f of files) {
  const text = readFileSync(path.join(src, f), 'utf8');
  let out;

  if (f === 'Clash.yaml') {
    out = [
      'port: 7890',
      'dns:',
      '  enable: true',
      '  use-hosts: true',
      '  nameserver:',
      '    - tls://119.29.29.29',
      'proxies:',
      ...proxies(text, 4),
      'hosts:',
      ...section(text, 'yaml:hosts').slice(0, 4),
      'rules:',
      ' - MATCH,DIRECT',
      '',
    ].join('\n');
  } else if (f === 'Quantumult X.txt') {
    out = [
      '[dns]',
      'server=/router.asus.com/system',
      ...text.split(/\r?\n/).filter((l) => /^alias=\//.test(l)).slice(0, 3),
      '',
      '[server_local]',
      ...proxies(text, 4),
      '',
    ].join('\n');
  } else {
    out = [
      '[General]',
      'loglevel = notify',
      '',
      '[Host]',
      ...section(text, 'host'),
      '',
      '[Proxy]',
      ...proxies(text, 4),
      '',
    ].join('\n');
  }

  writeFileSync(path.join(dst, f), sanitize(out));
  console.log(`写入 ${f}`);
}
