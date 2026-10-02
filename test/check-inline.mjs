// 校验 src/admin.js 内嵌的 APP_JS / CONFIG_JS / SETUP_JS 模板语法。
// 用 vm.Script 编译（只编译不执行）做语法检查，不 spawn 子进程，任何环境可跑。
// 历史教训：模板字符串里的正则 \d 会被吞、嵌套 function 会导致整页脚本挂掉，
// 改完内嵌脚本必须跑本检查。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src', 'admin.js'), 'utf8');

let failed = 0;
for (const name of ['APP_JS', 'CONFIG_JS', 'SETUP_JS']) {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(src);
  if (!m) {
    console.log(`FAIL  ${name}: 模板未匹配`);
    failed++;
    continue;
  }
  try {
    new vm.Script(m[1], { filename: `${name}.js` });
    console.log(`PASS  ${name} 语法正确（${m[1].split('\n').length} 行）`);
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
