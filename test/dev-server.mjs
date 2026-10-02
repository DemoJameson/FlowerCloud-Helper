/**
 * 本地开发环境一键启动（不构建镜像）。
 *
 *   npm run dev
 *
 * 拉起两部分：
 *   - test/mock-panel.mjs  假花云面板（9101），复刻真实页面结构
 *   - src/index.js         本体（8790），业务配置走 test/config.dev.json
 *
 * 前置：需要 FlareSolverr 在跑（用于过 Cloudflare；本机也能连到它即可）：
 *   docker run -d --name flaresolverr-dev --shm-size=2gb \
 *     -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
 *
 * 与生产完全隔离：独立端口、独立配置文件（test/config.dev.json）、
 * 独立订阅 Token，不碰 Docker 里的 flowercloud-helper:8787，也不碰 ./data。
 *
 * 停止时务必 Ctrl+C（会走优雅退出，释放 FlareSolverr 会话）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = [];
function run(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${name}]`;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.log(`${tag} ${l}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    console.log(`${tag} 退出 code=${code} signal=${signal}`);
    shutdown();
  });
  children.push(child);
  return child;
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n正在关闭（释放 FlareSolverr 会话，最多 20s）…');
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 22000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('启动本地开发环境…');
console.log('  mock 花云面板: http://127.0.0.1:9101');
console.log('  管理页面    : http://127.0.0.1:8790/   口令：见 test/config.dev.json 的 adminPassword 字段（未设置则首次访问时自设）');
console.log('  业务配置    : test/config.dev.json（与生产 data/ 隔离）');
console.log('  需要 FlareSolverr 在 8191 端口可用\n');

// mock 面板先起，等它ready
run('mock', ['test/mock-panel.mjs']);
await new Promise((r) => setTimeout(r, 800));

run('helper', ['src/index.js'], {
  PORT: '8790',
  CONFIG_FILE: path.join(root, 'test', 'config.dev.json'),
  // 本机跑时 FlareSolverr 映射到了 8191
  FLARESOLVERR_URL: process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191',
  FLARESOLVERR_TIMEOUT_MS: '120000',
  // 会话名与生产区分，避免两者抢同一个 FlareSolverr 会话
  SESSION_SUFFIX: 'dev',
  TZ: 'Asia/Shanghai',
});