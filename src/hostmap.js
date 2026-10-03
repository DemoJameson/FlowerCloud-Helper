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
 *
 * 两条刻意收窄的范围，都是「宁可少改也不能改坏」：
 *   1. **只认顶层 `hosts:`**，缩进更深的 `dns.hosts` 不碰。Clash/Mihomo 的
 *      顶层 hosts 才是「域名→域名」映射，dns 段下的 hosts 语义不同。
 *   2. **只改地址类字段**（server / sni / tls-host / host，以及各客户端
 *      节点行里表示服务器地址的位置参数）。节点的 password / uuid 恰好也可能
 *      等于某个占位域名，改了就是认证失败 —— 见 replaceDomains 的说明。
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
    // 必须限死「行首无缩进」：Clash/Mihomo 只有顶层 hosts 才是域名→域名映射，
    // 缩进更深的 hosts:（如 dns: 下的）语义不同，误当映射会把人家的配置改坏
    const y = line.match(/^hosts[ \t]*:[ \t]*(#.*)?$/);
    if (y) {
      blockStart = i;
      blockIndent = 0;
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
 * 出现「域名」时，判断它前面最近的那个键名是什么。
 * 返回 null 表示「这不是 key=value 结构」（如位置参数写法），由调用方另行判断。
 */
function fieldBefore(line, idx) {
  // 往前找最近的 key: 或 key=（含引号包裹的 YAML 键）
  const before = line.slice(0, idx);
  const m = before.match(/(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)[ \t]*[:=][ \t]*["']?$/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 各客户端节点行里「协议名」的位置参数写法：这些词出现在等号/逗号左边时
 * 是协议类型（trojan = host:port），不是字段名，不能按字段名去判地址。
 */
const PROTOCOL_WORDS = /^(?:trojan|ss|ssr|vmess|http|https|snell|socks5?|hysteria2?|tuic)$/;

/** 这些键名里的域名是「凭据」，改了会让节点认证失败 */
const CREDENTIAL_FIELDS = /^(?:password|passwd|pwd|uuid|alterid|token|secret|key|auth|psk)$/;

/** 这些键名表示「服务器地址」，要替换 */
const ADDRESS_FIELDS = /^(?:server|sni|tls-?host|servername|host|hostname|address|addr)$/;

/**
 * 逐行替换，把占位域名换掉，但**只改「地址类」字段**。
 *
 * 为什么不能整篇纯文本替换：节点的 password / uuid 恰好也可能等于某个占位
 * 域名（机场爱用同批域名做各种标识），一改就是节点认证失败。而 sni / tls
 * 名字段必须改 —— 那是 TLS 握手用的 Host，要与 server 换到同一个域名才对得上。
 *
 * 各客户端里表示「服务器地址」的写法：
 *   Clash / sing-box 等 YAML   server: / server: "x"  —— 具名字段
 *   Surge / Surfboard 等       = trojan,a.example.com,443,...   （位置参数）
 *   Quantumult X              trojan = a.example.com:443, ...   （等号后主机名）
 *   base64 的 v2ray/sing-box   ss://...@a.example.com:8388#name  （@ 与 : 之间）
 *
 * 判定顺序：先看该域名前面最近的键名 —— 是凭据字段就跳过，是地址字段就替换；
 * 没有键名（位置参数写法）再看整行是否像节点行。认不出的行一律不动 ——
 * 宁可少替换，也不能把密码改坏。
 */
function replaceDomains(text, map, onHit) {
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return text;

  // 一次匹配全部 key（长的排前面），单趟替换避免链式串味
  const re = new RegExp(`(?<![A-Za-z0-9_.-])(?:${keys.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`, 'g');

  return text
    .split('\n')
    .map((line) => {
      re.lastIndex = 0;
      if (!re.test(line)) return line;

      // 无键名的位置参数写法：整行像节点行才允许替换
      const positional =
        /\b(?:trojan|ss|ssr|vmess|http|https|snell|socks5?)\s*[,=]/i.test(line) ||
        /:\/\/[^@/\s]*@/.test(line) || // v2ray URI 的 @host:port
        /^\s*[\w-]+\s*=\s*[\w.-]+\.[a-z]{2,}/i.test(line); // QX 的 trojan = host:port

      re.lastIndex = 0;
      return line.replace(re, (m, offset) => {
        const field = fieldBefore(line, offset);

        if (field && !PROTOCOL_WORDS.test(field)) {
          // 具名字段：只改地址类字段；凭据字段（password/uuid 等）跳过
          if (CREDENTIAL_FIELDS.test(field) || !ADDRESS_FIELDS.test(field)) return m;
        } else if (!positional && !(field && PROTOCOL_WORDS.test(field))) {
          // 既没键名、也不像节点行 → 认不出来，不动
          return m;
        }
        onHit();
        return map.get(m) || m;
      });
    })
    .join('\n');
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
