import { defineConfig } from 'vitest/config';

// Talos's own additions to the generated Vitest base (vitest.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'bootstrap/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/bin/talos.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
