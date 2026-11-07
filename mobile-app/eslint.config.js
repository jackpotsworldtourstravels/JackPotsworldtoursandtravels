// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'coverage/*'],
  },
  {
    // Jest module factories must require() lazily; there is no import equivalent.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
