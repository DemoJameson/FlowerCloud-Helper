import { store } from './store.js';
import { startServer } from './server.js';
import { shutdown } from './state.js';
import { startAutoRefresh, stopAutoRefresh } from './scheduler.js';
import { log } from './logtime.js';

async function main() {
  const subCount = store.listSubs().length;
  log('[boot] FlowerCloud 订阅助手启动');
  log(
    `[boot] 配置：${store.data.accounts.length} 个机场账号 / ` +
      `${store.data.products.length} 个套餐 / ${subCount} 条订阅链接`
  );
  log('[boot] 订阅内容实时回源（流量随回源同步）；套餐结构在定时/手动「刷新全部」或订阅失效自愈时更新');

  startServer();
  // 定时「刷新全部」：默认每 20 分钟（设置页可改，0 关闭）。它抓的是套餐
  // 结构（机场换订阅地址、套餐上下架只有重新登录才知道），不等客户端拉失败
  // 再自愈 —— 那会先断一会儿。订阅内容仍然每次实时回源，不缓存。
  startAutoRefresh();
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
  // 先停定时刷新：否则清理期间可能又排上一轮，去抢正在释放的 FlareSolverr 会话
  stopAutoRefresh();
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