/**
 * 查看当前管理口令（本地找回用）。
 *
 *   npm run password
 *
 * 口令明文存于配置文件（adminPassword 字段），直接打开配置文件即可查看。
 * 配置路径解析顺序：
 *   1. 环境变量 CONFIG_FILE（Docker 部署为 /data/config.json）
 *   2. ./test/config.dev.json（本地开发环境，npm run dev 实际使用的配置）
 *   3. ./data/config.json（项目根目录手工放置的生产配置）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function resolveConfigFile() {
  if (process.env.CONFIG_FILE) return process.env.CONFIG_FILE;
  const candidates = [
    path.join(projectRoot, 'test', 'config.dev.json'),
    path.join(projectRoot, 'data', 'config.json'),
  ];
  return candidates.find((f) => fs.existsSync(f)) || candidates[0];
}

process.env.CONFIG_FILE ||= resolveConfigFile();

const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');

console.log(`配置文件：${config.configFile}`);

const pw = store.plainAdminPassword();
if (!pw) {
  console.log('尚未设置管理口令。首次访问管理页时会进入「首次设置」页。');
} else {
  console.log(`管理口令：${pw}`);
}
