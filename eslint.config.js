// ESLint flat config focused on security linting.
const js = require('@eslint/js');
const globals = require('globals');
const security = require('eslint-plugin-security');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

const sharedRules = {
  ...js.configs.recommended.rules,
  ...security.configs.recommended.rules,
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  // Omitting a key with `const { key, ...rest } = obj` is intentional
  'no-unused-vars': ['error', { ignoreRestSiblings: true }],
};

module.exports = [
  { ignores: ['node_modules/**', 'chat.db*'] },

  // Server-side Node.js code and tests
  {
    files: ['*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { security },
    rules: sharedRules,
  },

  // Browser code: also flag unsafe DOM sinks (innerHTML, insertAdjacentHTML, document.write, ...)
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, io: 'readonly' },
    },
    plugins: { security, 'no-unsanitized': noUnsanitized },
    rules: {
      ...sharedRules,
      // Only flags integer indexes into arrays here (pins[pinIndex]); all false positives
      'security/detect-object-injection': 'off',
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'no-script-url': 'error',
    },
  },
];
