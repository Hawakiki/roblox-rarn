import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * ESLint carries only the rules Biome cannot express.
 *
 * Biome does the formatting and the fast syntactic checks. What it structurally
 * cannot do is type-aware linting, because it never builds a type graph. That gap
 * matters here: Rarn downloads, extracts and writes in parallel, and an unawaited
 * promise does not fail loudly — it produces a half-written cache and an error
 * nobody sees. `no-floating-promises` is the reason this config exists.
 *
 * Stylistic rules stay off. typescript-eslint dropped formatting rules in v6, so
 * there is nothing here for Biome to fight with.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'RARN_MODULE/**', 'test/roblox/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The rules this config exists for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // An unchecked `any` from JSON.parse or a fetch body is exactly how a bad
      // registry response would slip into the resolver untyped.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      // Biome already reports unused symbols; leaving both on double-reports.
      '@typescript-eslint/no-unused-vars': 'off',

      // Rarn throws RarnError and nothing else, so this is genuinely enforceable.
      '@typescript-eslint/only-throw-error': 'error',

      // Template literals holding an object print "[object Object]" in a CLI
      // message, which is worse than useless when the message is the product.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests deliberately construct malformed input to prove it is rejected.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
