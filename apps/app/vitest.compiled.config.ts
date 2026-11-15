import path from "path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { forkablePluginPaths } from "./vite-forkable-plugin-paths.js";
import { sharedUiEnvSeam } from "./vite-shared-ui-seam.js";
import { cachedReactCompiler } from "./vite-react-compiler.js";

export default defineWorkspaceTestConfig({
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
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      aliases: { "@": path.resolve(__dirname, "./src") },
      name: "@bb/app:compiled",
      include: [
        "src/components/promptbox/context/*.test.tsx",
        "src/components/promptbox/FollowUpPromptBox.test.tsx",
        "src/components/plugin/PluginComposerBanners.test.tsx",
        "src/components/modal/*.test.tsx",
        "src/components/plugin/PluginThreadFixedTabs.continuity.test.tsx",
        "src/components/plugin/RetainedThreadTabContainer.test.tsx",
        "src/HashNavigationScroll.modal.test.tsx",
        "src/lib/app-route-history.test.tsx",
        "src/hooks/queries/thread-plans.test.tsx",
        "src/components/thread/pending-interactions/plan-editor-ownership.test.tsx",
        "src/views/thread-detail/thread-plan-focus.test.tsx",
        "src/views/thread-detail/ThreadPlanCard.test.tsx",
        "src/views/thread-detail/ThreadScreen.pending-send.test.tsx",
        "src/components/thread/timeline/PendingSendControls.banners.test.tsx",
        "src/views/thread-detail/ThreadPlanSteps.native-focus.test.tsx",
      ],
    }),
  },
});
