import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const reactAdvisories = {
  "react-hooks/set-state-in-effect": "warn",
  "react-hooks/refs": "warn",
  "react-hooks/purity": "warn",
};

const eslintConfig = defineConfig([
  ...nextVitals.map((config) =>
    config.plugins?.["react-hooks"]
      ? {
          ...config,
          rules: { ...config.rules, ...reactAdvisories },
        }
      : config,
  ),
  ...nextTs,
  {
    files: [
      "src/components/openmaic/**/*.{ts,tsx}",
      "src/lib/openmaic/**/*.{ts,tsx}",
    ],
    linterOptions: {
      // Keep upstream pragmas intact so future OpenMAIC updates remain
      // reviewable without directive-only merge churn.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // OpenMAIC playback/rendering code uses underscore-prefixed parameters
      // to preserve upstream callback signatures.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // Canvas and slide renderers need native image elements for blob/data
      // URLs, crop coordinates and snapshot fidelity; next/image changes
      // those semantics and is not an appropriate replacement here.
      "@next/next/no-img-element": "off",
      // These two React Compiler advisories reject established upstream state
      // machine and ref patterns. Runtime Hook ordering and dependency checks
      // remain enabled, as do TypeScript and the full test suite.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["packages/**/*.{js,mjs,ts,tsx}"],
    linterOptions: {
      // Compatibility forks retain upstream lint pragmas so they can be
      // rebased without source-only churn.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // Vendored compatibility packages intentionally preserve upstream API
      // signatures and generated geometry variables.
      "@typescript-eslint/no-unused-vars": "off",
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",
      "import/no-anonymous-default-export": "off",
    },
  },
  {
    files: ["packages/omml2mathml/**/*.js"],
    rules: {
      // This compatibility fork intentionally publishes CommonJS for its
      // downstream consumers. Requiring ESM here would change its API.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "public/**",
    ".openpbl-runtime/**",
    ".openpbl-data/**",
    ".cache/**",
    "artifacts/**",
    "workers/**",
    "backups/**",
    "**/dist/**",
    "**/*.d.ts",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
