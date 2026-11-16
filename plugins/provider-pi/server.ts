import { registerPiAiService } from "./src/ai/service.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(bb: BbPluginApi): void {
  registerPiAiService(bb);
  const registered = bb.providers.register(piProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
