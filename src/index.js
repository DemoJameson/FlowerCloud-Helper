import { store } from './store.js';
import { startServer } from './server.js';
import { shutdown } from './state.js';
import { log } from './logtime.js';

async function main() {
  const subCount = store.listSubs().length;
  log('[boot] FlowerCloud 订阅助手启动');
  log(
    `[boot] 配置：${store.data.accounts.length} 个机场账号 / ` +
      `${store.data.products.length} 个套餐 / ${subCount} 条订阅链接`
  );
  log('[boot] 订阅内容实时回源（流量随回源同步）；套餐结构在「刷新全部」或订阅失效自愈时更新');

  startServer();
  // 不做定时抓取：订阅内容每次实时回源，流量顺带同步；套餐结构靠手动
  // 「刷新全部」或订阅失效时的自动重授权 —— 定时抓只是白耗机场配额
}

/*
 * 优雅退出：先关掉 FlareSolverr 会话再退出，
 * 否则 FlareSolverr 那边会留着空会话占资源。
 */
let shuttingDown = false;
async function shutdownHandler(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[boot] 收到 ${signal}，开始退出…`);
  const force = setTimeout(() => {
    console.error('[boot] 清理超时，强制退出');
    process.exit(1);
  }, 15000);
  force.unref();
  try {
    await shutdown();
  } catch {
    /* 忽略清理异常 */
  }
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGINT', () => shutdownHandler('SIGINT'));
process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

// 兜住未捕获异常，避免进程僵着不走
process.on('uncaughtException', (e) => {
  console.error('[boot] 未捕获异常:', e);
  process.exit(1);
});

main().catch((e) => {
  console.error('[boot] 启动失败:', e.message);
  process.exit(1);
});