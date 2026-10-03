/**
 * 节点域名替换（把 hosts 映射落地到节点上）
 *
 * 机场下发订阅时，节点的 server 往往是一个「占位域名」，例如
 *   server: aaaa1111-2222.placeholder.example.com
 * 而真正能连的入口域名只出现在 hosts 映射里：
 *   aaaa1111-2222.placeholder.example.com = bbbb3333-4444.real-entry.example.net
 * 客户端必须支持并启用了 hosts 才能连上（Clash 要 use-hosts，
 * sing-box 之类内核干脆没有 hosts 概念），否则一律握手失败。
 *
 * 所以转发前把映射「落地」：删掉映射条目本身，再把正文里所有占位域名
 * 替换成真实域名。替换后客户端完全不依赖 hosts，节点 server 就是真域名。
 *
 * 识别的映射写法（其余格式一律原样透传，所以通用订阅不受影响）：
 *   Clash / Mihomo      hosts:\n  a.com: b.com
 *   Surge / Loon /      [Host]\n  a.com = b.com
 *   Surfboard / Shadowrocket
 *   Quantumult X        [dns] 段里的 alias=/a.com/b.com
 *
 * 值不是裸域名的映射（= server:1.1.1.1、= system、= localhost 之类）
 * 一律忽略 —— 那是机场自带的 DNS 分流，改了会改坏行为。
 */

/** 裸域名：至少一个点、每段合法、顶级域含字母（借 latter 排掉 IP） */
const DOMAIN_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function isDomain(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!DOMAIN_RE.test(s)) return false;
  // 顶级域必须是字母，不能是 1.1.1.1 / 0.0.0.0 这类 IPv4
  return /[A-Za-z]/.test(s.slice(s.lastIndexOf('.') + 1));
}

function unquote(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(?:"([^"]*)"|'([^']*)')$/);
  return (m ? m[1] ?? m[2] : s).trim();
}

/**
 * 从 hosts 映射的值里取出唯一那个裸域名。
 * 支持 `b.com`、`[b.com]`、YAML 数组首项 `- b.com`、行尾带注释等形式；
 * 取不到返回 null（说明这不是域名→域名的映射，该保留原样）。
 */
function firstDomain(val) {
  if (val === undefined || val === null) return null;
  let s = String(val).trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    s = end > 0 ? s.slice(1, end) : s.slice(1);
  }
  // 行尾注释（YAML 里值后面可能跟 # 说明）
  const hash = s.indexOf(' #');
  if (hash > 0) s = s.slice(0, hash);
  const first = (s.split(/[,\s]+/)[0] || '').replace(/^-+/, '');
  const t = unquote(first);
  return isDomain(t) ? t : null;
}

function addPair(map, rawKey, val) {
  const from = unquote(rawKey);
  const to = firstDomain(val);
  if (!isDomain(from) || !to || from === to) return false;
  if (map.has(from)) return false; // 先出现的映射优先，不覆盖
  map.set(from, to);
  return true;
}

/**
 * 一次行扫描抽出映射，并记下要删掉的行号。
 * blocks 记录 Clash hosts 块的位置，用来判断删空后要不要连键名一起删。
 */
function scanLines(lines) {
  const map = new Map();
  const drop = new Set();
  const blocks = [];
  let inHostSection = false;
  let blockStart = -1;
  let blockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');

    const sec = line.match(/^[ \t]*\[([^\]]+)\][ \t]*$/);
    if (sec) {
      inHostSection = /^(host|hosts)$/i.test(sec[1].trim());
      blockStart = -1;
      continue;
    }

    // Clash 顶层 hosts:（行首无缩进，子项缩进更深）
    const y = line.match(/^([ \t]*)hosts[ \t]*:[ \t]*(#.*)?$/);
    if (y) {
      blockStart = i;
      blockIndent = y[1].length;
      continue;
    }

    const indent = (line.match(/^[ \t]*/) || [''])[0].length;

    if (blockStart >= 0) {
      if (!line.trim()) continue; // 空行不结束块
      if (indent > blockIndent) {
        const m = line.match(/^[ \t]*(?:"([^"]*)"|'([^']*)'|([^:#]+?))[ \t]*:[ \t]*(.*)$/);
        if (m && addPair(map, m[1] ?? m[2] ?? m[3], m[4])) drop.add(i);
        continue;
      }
      blocks.push({ start: blockStart, end: i });
      blockStart = -1;
    }

    if (inHostSection) {
      const m = line.match(/^[ \t]*(?:"([^"]*)"|'([^']*)'|([^=]+?))[ \t]*=[ \t]*(.*)$/);
      if (m && addPair(map, m[1] ?? m[2] ?? m[3], m[4])) drop.add(i);
      continue;
    }

    // Quantumult X：alias=/a.com/b.com
    const a = line.match(/^[ \t]*alias[ \t]*=[ \t]*\/([^/\s=]+)\/([^/\s=]+)[ \t]*$/);
    if (a && addPair(map, a[1], a[2])) drop.add(i);
  }
  if (blockStart >= 0) blocks.push({ start: blockStart, end: lines.length });

  return { map, drop, blocks };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 正文里的占位域名 → 真实域名。
 * 长 key 先替，避免 a.com 与 b.a.com 之类互相吃掉对方的前缀。
 */
function replaceDomains(text, map, onHit) {
  let out = text;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(k)}(?![A-Za-z0-9_-])`, 'g');
    out = out.replace(re, () => {
      onHit();
      return map.get(k);
    });
  }
  return out;
}

/** 解析手动映射：SUB_HOST_MAP="a.com=b.com, c.com=d.com" */
export function parseManualMap(raw) {
  const map = new Map();
  for (const pair of String(raw || '').split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) addPair(map, k.trim(), v.trim());
  }
  return map;
}

/** base64 订阅（v2ray / sing-box 那种纯编码文本）？是则返回解码后的明文 */
function tryDecodeBase64(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.length < 80 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  let text;
  try {
    text = Buffer.from(compact, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return text.includes('://') ? text : null;
}

const unchanged = (body) => ({ body, count: 0, pairs: [] });

/**
 * 入口：把订阅正文里的占位域名换成真实域名。
 *
 * @param {string} body 订阅原文
 * @param {string} [manualMap] 手动映射 "a.com=b.com,..."（base64 订阅看不到 hosts 段时用）
 * @returns {{ body:string, count:number, pairs:[string[]] }} count 为替换处数，0 表示原样返回
 */
export function rewriteHostDomains(body, manualMap) {
  if (typeof body !== 'string' || !body.trim()) return unchanged(body);

  const manual = parseManualMap(manualMap);

  // base64 订阅里没有 hosts 段可读，只能靠手动映射
  const b64 = tryDecodeBase64(body);
  if (b64) {
    if (!manual.size) return unchanged(body);
    let count = 0;
    const out = replaceDomains(b64, manual, () => count++);
    if (!count) return unchanged(body);
    return { body: Buffer.from(out, 'utf8').toString('base64'), count, pairs: [...manual] };
  }

  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const { map, drop, blocks } = scanLines(lines);
  // 手动映射优先：自动提取覆盖不到 / 配错时才需要手填
  for (const [k, v] of manual) if (!map.has(k)) map.set(k, v);
  if (!map.size) return unchanged(body);

  // 映射条目删空后，Clash 的 hosts: 键名也一并删掉，免得留个空壳
  const finalDrop = new Set(drop);
  for (const b of blocks) {
    const kept = lines
      .slice(b.start + 1, b.end)
      .some((l, idx) => l.trim() && !finalDrop.has(b.start + 1 + idx));
    if (!kept) finalDrop.add(b.start);
  }

  let out = lines.filter((_, i) => !finalDrop.has(i)).join('\n');
  let count = 0;
  out = replaceDomains(out, map, () => count++);
  if (!count) return unchanged(body);

  return { body: eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out, count, pairs: [...map] };
}
