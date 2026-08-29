import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests run without a build step.
      '@flanj/redaction-patterns': resolve(__dirname, 'packages/redaction-patterns/src/index.ts')
    }
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'packages/*/test/**/*.spec.ts'],
    reporters: ['default']
  }
});
