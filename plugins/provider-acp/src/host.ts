import { createOpenCodeGoRuntime } from "./ai/go-runtime.js";
import { createOpenRouterRuntime } from "./ai/runtime.js";
import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_probeAcpAgent } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { acpHostContract } from "./contract.js";
import { resolveAcpNativeRoots } from "./native-roots/index.js";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

const openRouter = createOpenRouterRuntime();
const openCodeGo = createOpenCodeGoRuntime();

export default experimental_defineHostEntry({
  contract: acpHostContract,
  handlers: {
    "openrouter.ai.models": (_input, context) => openRouter.models(context.signal),
    "openrouter.ai.generate": (input, context) => openRouter.generate(input, context.signal),
    "opencodego.ai.models": (_input, context) => openCodeGo.models(context.signal),
    "opencodego.ai.generate": (input, context) => openCodeGo.generate(input, context.signal),
    probeAgent: async (input, context) =>
      experimental_probeAcpAgent({
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: context.experimental_paths.tempDir,
      }),
    resolveNativeRoots: (input) =>
      resolveAcpNativeRoots({
        agentId: input.providerId,
        cwd: input.cwd,
        homeDir: os.homedir(),
        env: process.env,
      }),
  },
});
