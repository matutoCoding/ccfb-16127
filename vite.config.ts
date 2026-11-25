import { defineConfig } from 'vite';

// 义眼片配色比对系统 —— 纯静态构建，IndexedDB 本地存储
export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    // 验收脚本走 tsx scripts/verify.ts
  } as never,
});
