/**
 * ESLint flat config.
 *
 * The point of this file is not style — it is to make the rules we learned the hard way
 * MECHANICAL. A rule a linter checks survives; a rule in prose erodes (CLAUDE.md). Every
 * `no-restricted-*` entry below traces to a real defect or a documented landmine, and
 * carries the reason inline so the next person cannot mistake it for taste.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "packages/db/drizzle/**", // generated migrations
      "**/*.d.ts",
      "**/next-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The highest-value rules in this file. Idempotency, persistence and Stripe calls
       * are all async; a dropped `await` on `claimEvent` or `upsert` fails silently and
       * looks exactly like success. These turn that into a build error.
       */
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "off", // ports are async by contract, not by body

      /** Money is integer cents, always (CLAUDE.md landmine). */
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is integer cents. Never parse money as a float." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Number",
          property: "parseFloat",
          message: "Money is integer cents. Never parse money as a float.",
        },
      ],

      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off", // deliberate: webhook + scripts report through the console
    },
  },

  /**
   * Library packages are consumed by every surface, so they stay free of I/O concerns
   * their callers should own.
   */
  {
    files: ["packages/**/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Packages must not read process.env. Take config as an argument so the wiring layer owns it (DOSI-S) and tests need no environment.",
        },
      ],
    },
  },

  /**
   * Files that live outside any tsconfig project (package tests, standalone scripts,
   * root configs) cannot be type-checked, so the type-aware rules are switched off for
   * them rather than contorting the build tsconfigs to include non-emitting files.
   * Everything in packages/<pkg>/src and apps/marketing IS in a project and keeps them.
   */
  {
    files: [
      "packages/**/test/**/*.ts",
      "scripts/**/*.ts",
      "packages/db/drizzle.config.ts",
      "*.config.ts",
      "*.config.mjs",
      "**/*.mjs",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "no-restricted-syntax": "off",
    },
  },
);
