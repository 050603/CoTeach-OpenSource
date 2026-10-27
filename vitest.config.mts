import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    server: {
      // @platejs/docx-io publishes ESM that relies on extensionless
      // virtual-dom imports. Let Vite resolve and transform that package so
      // archive tests exercise the same bundled path used by Next.js.
      deps: { inline: ["@platejs/docx-io"] },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      // Thresholds intentionally set just below current coverage to act as
      // "no regression" gates. Current baseline (2026-07):
      //   lines 25.42 / functions 35.59 / branches 23.57 / statements 25.92.
      // Raise progressively as more unit tests are added. Target: 70/70/60/70.
      thresholds: {
        lines: 20,
        functions: 30,
        branches: 20,
        statements: 20,
      },
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "src/lib/openmaic/**",
        "src/lib/**/*.d.ts",
        "src/lib/**/types.ts",
      ],
    },
  },
});
