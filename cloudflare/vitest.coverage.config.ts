import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // These suites use Cloudflare's real isolated D1 binding and therefore run
    // in the Workers pool, not the Node-only coverage pool.
    exclude: [
      "tests/accounting/d1-edit-integration.test.ts",
      "tests/reports/read-parity-polish.test.ts",
      "tests/routes/customer-api-d1-integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/index.ts"],
      reportsDirectory: "coverage",
      thresholds: { statements:55,branches:40,functions:55,lines:60 },
    },
  },
});
