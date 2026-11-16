import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  test: {
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-autosay",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    }),
  },
});
