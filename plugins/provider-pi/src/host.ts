import { defineRpcContract } from "@get-bb/plugin-sdk";
import { piAiContract } from "./ai/contract.js";
import { createPiAiRuntime } from "./ai/runtime.js";
import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { resolvePiNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

const ai = createPiAiRuntime();

export default experimental_defineHostEntry({
  contract: defineRpcContract({
    ...experimental_nativeRootsHostContract,
    ...piAiContract,
  }),
  handlers: {
    "pi.ai.models": (_input, context) => ai.models(context.signal),
    "pi.ai.generate": (input, context) => ai.generate(input, context.signal),
    resolveNativeRoots: () =>
      resolvePiNativeRoots({ homeDir: homedir(), env: process.env }),
  },
});
