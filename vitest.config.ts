import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 90,
        branches: 84,
        functions: 98,
        lines: 90,
      },
      exclude: [
        "node_modules/**",
        "dist/**",
        "coverage/**",
        "test/**",
        "scripts/**",
        "**/*.config.*",
        "**/*.d.ts",
        "**/types.ts",
      ],
    },
  },
});
