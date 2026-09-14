import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {},
  },
  {
    // Node-only test bench (run via ai-sim/stub.js)
    files: ['ai-sim/**/*.mjs', 'ai-sim/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // the tuning playground runs in the browser (not Node)
    files: ['ai-sim/playground.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  {
    // ws-e2e drives browser pages — its page.evaluate/waitForFunction
    // callbacks run in the page (browser globals), not in Node
    files: ['ai-sim/ws-e2e.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // the server-authoritative WS server (Node + ws)
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, WebSocket: 'readonly' },
    },
  },
];
