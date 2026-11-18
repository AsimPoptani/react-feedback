import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.{ts,tsx}", "server/dom/**/*.dom.ts"],
  },
});
