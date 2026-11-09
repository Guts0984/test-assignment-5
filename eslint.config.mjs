import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      'packages/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // Nest relies on runtime imports for decorator metadata, so type-only
        // enforcement is disabled for apps/api below.
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Config files are plain JS outside any tsconfig: no type-aware rules.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // CommonJS files (such as the preload script of the web container) must use require().
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Classes are only allowed in NestJS code (apps/api); everything else is functional.
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['apps/api/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ClassDeclaration, ClassExpression',
          message:
            'Classes are only allowed in apps/api (NestJS). Use functions and plain objects.',
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // The web app: React Hooks, Next.js and accessibility rules, plus the architecture guards.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin, 'jsx-a11y': jsxA11y },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      // Async event handlers (onClick, onSubmit) are normal in React: the event system ignores the promise.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Feature-based architecture: another feature is used only through its index.ts.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/*'],
              message: 'Import a feature through its index (@/features/<name>), not its internals.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests may reach into a feature's internals to test it directly.
    files: ['apps/web/test/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // Every API call goes through one of two clients, so the visitor's address is never forgotten
    // on server-side calls (see apps/web/src/shared/lib/server-api.ts).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/shared/lib/client-api.ts', 'apps/web/src/shared/lib/server-api.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'Use apiFetch/loadPrivate (server) or api (browser) from src/shared/lib.',
        },
      ],
    },
  },
  prettier,
);
