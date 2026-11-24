import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 60000,
    // Astro builds share process-wide state: run test files one at a time
    fileParallelism: false,
  },
});
