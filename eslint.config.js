const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo']
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off'
    }
  },
  {
    // The redaction floor must NEVER do I/O: it runs on every captured body, in-process,
    // before anything is stored or transmitted (zero-external-calls is audited). Ban every
    // network / DNS / process / filesystem primitive from the floor's source. The runtime
    // sentinel test (packages/redaction-patterns/test/no-network.spec.ts) is the other half.
    files: ['packages/redaction-patterns/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'http', 'https', 'net', 'dns', 'tls', 'dgram', 'child_process', 'fs', 'worker_threads',
            'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'node:dgram',
            'node:child_process', 'node:fs', 'node:fs/promises', 'node:worker_threads'
          ].map((name) => ({ name, message: 'The redaction floor must never perform I/O (zero-external-calls).' })),
          patterns: [
            { group: ['undici', 'axios', 'node-fetch', 'got', 'ws'], message: 'No network clients in the redaction floor.' }
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The redaction floor must never perform I/O (zero-external-calls).' },
        { name: 'XMLHttpRequest', message: 'The redaction floor must never perform I/O.' },
        { name: 'WebSocket', message: 'The redaction floor must never perform I/O.' }
      ]
    }
  },
  {
    // Tests assert against loosely-typed golden fixtures.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
