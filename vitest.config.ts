import "./test-isolation-preflight.mjs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: "bb-plugin-account-pool",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./test-network-guard.ts"],
  },
});
