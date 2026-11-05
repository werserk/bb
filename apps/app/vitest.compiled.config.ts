import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { forkablePluginPaths } from "./vite-forkable-plugin-paths.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";
import { cachedReactCompiler } from "./vite-react-compiler.js";

export default defineConfig({
  plugins: [
    forkablePluginPaths(path.resolve(__dirname, "./src")),
    sharedUiEnvSeam(),
    react(),
    await cachedReactCompiler(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    conditions: ["source"],
  },
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 15_000,
    include: [
      "src/components/modal/*.test.tsx",
      "src/HashNavigationScroll.modal.test.tsx",
      "src/lib/app-route-history.test.tsx",
    ],
  },
});
