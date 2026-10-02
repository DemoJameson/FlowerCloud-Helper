import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function optional(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function int(name, def) {
  const v = process.env[name];
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? def : n;
}

// 默认数据目录跟随项目（本地开发友好）；Docker 镜像里用 ENV 固定到 /data，
// 否则 Windows 裸跑 npm start 会写到 C:\data\config.json 这种诡异位置
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 环境变量只承载「部署基础设施」；业务配置（花云地址 / 邮箱 / 密码 /
 * 订阅 Token）全部存放在 config.json，通过管理页配置。
 * 详见 store.js。
 */
export const config = {
  port: int('PORT', 8787),

  // 业务配置文件（管理页读写、导出导入的就是它）
  configFile: optional('CONFIG_FILE', path.join(projectRoot, 'data', 'config.json')),

  // 会话有效期（小时）
  sessionTtlHours: int('SESSION_TTL_HOURS', 12),
  // 对外公布的订阅地址前缀。设置后 /api/status 生成的 subUrl 永远用它，
  // 不再跟随浏览器访问用的 Host —— 用 localhost 打开管理页时，复制出来的
  // 仍是局域网/公网可达的地址（如 http://192.168.50.2:8787）。留空则跟随 Host。
  publicUrl: optional('PUBLIC_URL').replace(/\/+$/, ''),

  // FlareSolverr 负责过 Cloudflare 人机验证，本服务不再跑浏览器
  flareSolverrUrl: optional('FLARESOLVERR_URL', 'http://flaresolverr:8191'),
  // 单次请求 FlareSolverr 的最长等待（毫秒）
  cfTimeoutMs: int('FLARESOLVERR_TIMEOUT_MS', 120000),
  // 会话名后缀：同一台机器跑多个实例时用不同会话名互不干扰
  sessionIdSuffix: optional('SESSION_SUFFIX', 'default'),

  // 调试文件目录（管理页 /api/debug 只读列出，需手动放置）
  debugDir: optional('DEBUG_DIR', path.join(projectRoot, 'data', 'debug')),

  // 订阅地址回源拉取（fetchsub.js 用作 referer 兜底）
  baseUrl: optional('BASE_URL', 'https://api-flowercloud.com'),
};
