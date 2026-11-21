import { defineConfig } from 'vitest/config';
import aliases from './vitest.aliases.js';

export default defineConfig({
  resolve: {
    alias: aliases,
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
    restoreMocks: true,
    pool: 'forks',
    // 集成测试共享资源注册表/runId，按文件串行执行。
    fileParallelism: false,
  },
});
