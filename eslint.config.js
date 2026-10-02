import js from '@eslint/js';

/**
 * ESLint 扁平配置。
 *
 * 本项目所有代码都跑在 Node（前端脚本内联在模板字符串里，不参与 lint），
 * 所以只需要声明 Node 全局对象。核心诉求是 no-undef —— 上一版的
 * 「引用了未 import 的常量」就是靠它拦住的。
 */

/** Node 运行时全局对象（显式列出，避免为了几个名字引入 globals 依赖） */
const nodeGlobals = {
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'data/**', 'test-data/**', '.workbuddy/**', '.idea/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // 导出时用 rest 解构剔除字段（const { a, ...rest } = obj），a 视为已使用
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
];
