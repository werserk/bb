import { fileURLToPath } from "node:url";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "./vitest.shared.js";

const pkgDir = fileURLToPath(new URL("./plugins/provider-acp/", import.meta.url));

export default defineWorkspaceTestConfig({
  root: pkgDir,
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir,
      name: "bb-plugin-provider-acp",
      include: ["*.test.ts", "*.test.tsx", "src/**/*.test.ts"],
      exclude: ["node_modules/**"],
    }),
  },
});
