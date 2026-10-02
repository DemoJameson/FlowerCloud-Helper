/**
 * 日志时间戳
 *
 * 统一按容器/进程的时区（TZ 环境变量，镜像内置 Asia/Shanghai）输出本地时间，
 * 不再一律用 toISOString() —— 那是硬编码 UTC，即使设了 TZ 也照样显示 UTC，
 * 与用户看到的时间差一个时区（如北京时间 12:00 会打成 04:00）。
 *
 * 形如 2026-10-03 12:00:00.123，一眼能对上本地作息。
 */

/** 按当前时区格式化为 'YYYY-MM-DD HH:mm:ss.SSS' */
export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 按当前时区格式化为 'YYYY-MM-DD'。
 * 用于配置文件名（导出的备份名）、套餐到期日这类按本地日期判断的场景。
 */
export function dateOnly(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 控制台日志前缀：一次求值，后续各次调用只取时间 */
export const log = (...a) => console.log(stamp(), ...a);
