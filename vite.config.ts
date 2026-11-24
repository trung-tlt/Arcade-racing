import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/**/*.test.ts'],
    // The headless race tests keep a core busy for seconds; on a 2-core CI runner, parallel workers starve vitest's own
    // process and its "Timeout calling onTaskUpdate" fails a run whose tests all passed. Leave it a core.
    maxWorkers: process.env.CI ? 1 : undefined,
  },
});
