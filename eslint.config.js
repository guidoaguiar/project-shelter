// Dev-only lint config: mirrors SonarQube's "Sonar way" profile for JavaScript, so `npm run lint`
// and CI report what SonarQube for IDE shows in the editor. Every package used here is a
// devDependency: Docker and the installers never install them, and Shelter keeps zero runtime dependencies.
//
// Sonar way = all recommended eslint-plugin-sonarjs rules, plus the rules below that SonarQube takes
// from ESLint core, unicorn and typescript-eslint. (Its 5 rules from eslint-plugin-import and
// eslint-plugin-promise are not included.)
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const CORE = [
  'constructor-super', 'getter-return', 'new-cap', 'no-await-in-loop', 'no-caller', 'no-case-declarations',
  'no-constant-binary-expression', 'no-constructor-return', 'no-dupe-args', 'no-dupe-keys', 'no-empty', 'no-empty-pattern',
  'no-extend-native', 'no-extra-bind', 'no-extra-boolean-cast', 'no-import-assign', 'no-lone-blocks', 'no-lonely-if',
  'no-loss-of-precision', 'no-multi-str', 'no-new-native-nonconstructor', 'no-octal', 'no-octal-escape', 'no-proto',
  'no-self-assign', 'no-self-compare', 'no-sequences', 'no-setter-return', 'no-sparse-arrays', 'no-throw-literal',
  'no-undef-init', 'no-unmodified-loop-condition', 'no-unneeded-ternary', 'no-unreachable', 'no-unreachable-loop',
  'no-unsafe-finally', 'no-unsafe-negation', 'no-unsafe-optional-chaining', 'no-unused-private-class-members',
  'no-useless-call', 'no-useless-constructor', 'no-useless-escape', 'no-useless-rename', 'no-var', 'no-with',
  'prefer-object-has-own', 'prefer-object-spread', 'prefer-regex-literals', 'prefer-spread', 'use-isnan', 'valid-typeof',
];
const UNICORN = [
  'catch-error-name', 'consistent-date-clone', 'consistent-empty-array-spread', 'consistent-function-scoping',
  'dom-node-dataset', 'error-message', 'new-for-builtins', 'no-abusive-eslint-disable', 'no-accessor-recursion',
  'no-anonymous-default-export', 'no-array-method-this-argument', 'no-instanceof-builtins',
  'no-invalid-fetch-options', 'no-named-default', 'no-negation-in-equality-check', 'no-object-as-default-parameter',
  'no-single-promise-in-promise-methods', 'no-thenable', 'no-this-assignment', 'no-typeof-undefined',
  'no-unnecessary-polyfills', 'no-unreadable-iife', 'no-useless-fallback-in-spread', 'no-useless-length-check',
  'no-useless-promise-resolve-reject', 'no-useless-spread', 'numeric-separators-style', 'prefer-array-find',
  'prefer-array-flat', 'prefer-array-flat-map', 'prefer-array-index-of', 'prefer-array-some', 'prefer-at',
  'prefer-blob-reading-methods', 'prefer-class-fields', 'prefer-code-point', 'prefer-date-now', 'prefer-default-parameters',
  'prefer-dom-node-remove', 'prefer-export-from', 'prefer-includes', 'prefer-math-min-max', 'prefer-math-trunc',
  'prefer-modern-dom-apis', 'prefer-modern-math-apis', 'prefer-native-coercion-functions', 'prefer-negative-index',
  'prefer-node-protocol', 'prefer-number-properties', 'prefer-prototype-methods', 'prefer-set-has', 'prefer-set-size',
  'prefer-single-call', 'prefer-string-raw', 'prefer-string-replace-all', 'prefer-string-trim-start-end',
  'prefer-structured-clone', 'prefer-top-level-await', 'prefer-type-error', 'require-module-specifiers',
];
// typescript-eslint rules that apply to JavaScript. SonarQube's own wrappers of no-empty-function,
// no-misused-promises, no-redeclare, no-unused-expressions and prefer-nullish-coalescing filter
// out most reports, so the raw rules would flag far more than the editor does: they are left out.
const TS = [
  'await-thenable', 'default-param-last', 'no-base-to-string', 'no-floating-promises', 'prefer-for-of',
  'prefer-optional-chain', 'prefer-promise-reject-errors', 'prefer-readonly', 'prefer-string-starts-ends-with', 'require-await',
];
const on = (prefix, names) => Object.fromEntries(names.map((n) => [prefix + n, 'error']));

export default [
  { ignores: ['node_modules/', 'data/', 'public/data/'] },
  sonarjs.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      // Type information for the typescript-eslint rules comes from jsconfig.json.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { unicorn, '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...on('', CORE),
      'max-params': ['error', { max: 7 }], // Sonar S107 threshold
      'new-cap': ['error', { capIsNew: false }], // Sonar S2430 only checks `new lowercase()`
      'no-undef': 'error', // not in Sonar way, but a misspelt name is always a bug
      ...on('unicorn/', UNICORN),
      ...on('@typescript-eslint/', TS),
    },
  },
  {
    files: ['server.js', 'server/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Tests poll in sequence, use plain-http fixture URLs and async stubs on purpose.
    files: ['test/**/*.js'],
    rules: {
      'no-await-in-loop': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
];
