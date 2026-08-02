import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      thresholds: {
        "src/domain/jobs.ts": { lines: 85, branches: 85 },
        "src/domain/claiming.ts": { lines: 85, branches: 85 },
        "src/domain/interaction.ts": { lines: 85, branches: 85 },
        "src/domain/reconciliation.ts": { lines: 85, branches: 85 },
      },
    },
  },
});
