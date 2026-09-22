// `.mts`, not `.ts`: this package is CommonJS, so a `.ts` config is loaded as CommonJS, and
// vitest's CommonJS config entry `require()`s an ES-module-only dependency. That needs
// `require(esm)`, which the Node floors this package supports (20.16, 22.3) do not have, so
// the suite could not even start on them. As an ES module the config loads on every line.
import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its source so tests run without a build step.
      '@flanj/redaction-patterns': resolve(root, 'packages/redaction-patterns/src/index.ts')
    }
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts', 'packages/*/test/**/*.spec.ts'],
    reporters: ['default']
  }
});
