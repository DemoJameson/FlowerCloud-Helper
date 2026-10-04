/**
 * 定时「刷新全部」（默认每 20 分钟一次）。
 *
 * 订阅内容是实时回源的，不靠这里的定时；定时器抓的是**套餐结构**——
 * 机场换订阅地址、套餐上下架、上游 token 轮换，都要重新登录面板才能发现。
 * 只靠「客户端拉失败再自愈」的话，用户会先断一会儿；定时跑一遍能把这事
 * 提前做完，仪表盘上的流量与到期也跟着一直是最新的。
 *
 * 实现上刻意做成「跑完再排下一次」，而不是死板的 setInterval：
 * 一次刷新要登录 N 个账号、抓 N×M 个页面，慢的时候远超 20 分钟，
 * 固定间隔会让下一轮在前一轮还没结束时又压上来（两边抢同一条
 * FlareSolverr 会话，只是排队白耗机场配额）。
 * 同理，检测到已有刷新在跑（手动点的、或订阅失效触发的）就整轮跳过。
 *
 * 间隔可在管理页「设置」里改（config.json 的 autoRefreshMinutes，分钟，
 * 0 = 关闭），改完立即按新间隔重新计时。
 */
import { store } from './store.js';
import { refreshAll, refreshInProgress } from './state.js';
import { log } from './logtime.js';

/**
 * 启动后第一次刷新的延迟。compose 里 depends_on 只等容器起来，不等
 * FlareSolverr 的 Chromium 就绪 —— 立刻刷大概率白撞一次「连不上」。
 */
const FIRST_RUN_DELAY_MS = 10_000;

/** 没配账号时整轮跳过，日志最多 6 小时打一条（否则每 20 分钟刷一次屏） */
const NO_ACCOUNT_LOG_INTERVAL_MS = 6 * 3600 * 1000;

const state = {
  running: false,
  lastRunAt: 0,
  lastOk: null, // null=还没跑过
  lastError: '',
  lastFinishAt: 0,
  nextRunAt: 0,
  runs: 0,
  skipped: 0,
};

let timer = null;
let stopped = false;
let lastNoAccountLogAt = 0;

/** 当前配置的间隔（毫秒）；0 = 关闭 */
function intervalMs() {
  const m = Number(store.data.autoRefreshMinutes);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.round(m * 60_000);
}

/** 排下一次；delay<=0 表示不排（已关闭或已停止） */
function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!delay || stopped) {
    state.nextRunAt = 0;
    return;
  }
  timer = setTimeout(tick, delay);
  // 定时器不该阻止进程退出：真正让进程活着的是 HTTP 服务
  timer.unref?.();
  state.nextRunAt = Date.now() + delay;
}

async function tick() {
  if (stopped) return;
  const ms = intervalMs();
  if (!ms) {
    // 间隔被改成 0（关闭）：停在这里，等下次 applyAutoRefresh 重新拉起
    state.nextRunAt = 0;
    return;
  }

  if (!store.data.accounts.length) {
    state.skipped++;
    const now = Date.now();
    if (now - lastNoAccountLogAt > NO_ACCOUNT_LOG_INTERVAL_MS) {
      lastNoAccountLogAt = now;
      log('[auto] 尚未配置机场账号，跳过本轮自动刷新');
    }
    schedule(ms);
    return;
  }

  if (refreshInProgress()) {
    // 手动刷新 / 订阅失效自愈正在跑：这一轮直接放弃，不排队堆积
    state.skipped++;
    log('[auto] 已有刷新在进行中，跳过本轮自动刷新');
    schedule(ms);
    return;
  }

  state.running = true;
  state.lastRunAt = Date.now();
  state.runs++;
  try {
    const out = await refreshAll('auto');
    state.lastOk = out.ok;
    state.lastError = out.ok ? '' : (out.results.find((r) => r.error)?.error || '全部账号刷新失败');
    log(`[auto] 本轮自动刷新完成（${out.okCount}/${out.total} 个账号成功）`);
  } catch (e) {
    // 单个账号失败 refreshAll 不会抛，走到这里都是「没配账号」这类整体性问题
    state.lastOk = false;
    state.lastError = e?.message || String(e);
    log(`[auto] 自动刷新失败: ${state.lastError}`);
  } finally {
    state.running = false;
    state.lastFinishAt = Date.now();
    // 跑完才排下一次：间隔从本轮结束起算，绝不会自我叠加
    schedule(stopped ? 0 : intervalMs());
  }
}

/**
 * 启动（或重新应用）定时刷新。配置改动后调用即可按新间隔重新计时。
 * @param {{ firstDelayMs?: number }} [opts] 首次刷新延迟，仅测试注入用
 */
export function startAutoRefresh(opts = {}) {
  const firstDelayMs = Number(opts.firstDelayMs ?? FIRST_RUN_DELAY_MS);
  stopped = false;
  const ms = intervalMs();
  if (!ms) {
    if (timer) clearTimeout(timer);
    timer = null;
    state.nextRunAt = 0;
    log('[auto] 自动刷新已关闭（间隔为 0）');
    return false;
  }
  schedule(Math.max(0, firstDelayMs));
  // 管理页改间隔时 firstDelayMs 就是一个完整间隔，按秒读出来会很难看
  const firstText =
    firstDelayMs >= 60_000
      ? `${Math.round(firstDelayMs / 60_000)} 分钟`
      : `${Math.round(firstDelayMs / 1000)} 秒`;
  log(`[auto] 自动刷新已开启：每 ${store.data.autoRefreshMinutes} 分钟刷新全部（首次在 ${firstText}后）`);
  return true;
}

/** 停止定时刷新（进程退出前调用）；正在跑的那一轮不打断，只是不再排下一次 */
export function stopAutoRefresh() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextRunAt = 0;
}

/** 自动刷新状态（/status 与管理页用） */
export function autoRefreshStatus() {
  return {
    minutes: Number(store.data.autoRefreshMinutes) || 0,
    enabled: intervalMs() > 0,
    running: state.running,
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastFinishAt: state.lastFinishAt ? new Date(state.lastFinishAt).toISOString() : null,
    lastOk: state.lastOk,
    lastError: state.lastError || '',
    nextRunAt: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
    runs: state.runs,
    skipped: state.skipped,
  };
}
