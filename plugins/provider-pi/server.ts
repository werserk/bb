import { z } from "zod";
import { registerPiAiService } from "./src/ai/service.js";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const schema = z.enum(["default", "lowest-latency"]);
  const settings = bb.settings.define({
    nativeGenerationRouting: {
      type: "select",
      label: "Native generation routing",
      description:
        "OpenRouter text generation only. Lowest latency requires parameter support and disables provider fallbacks. Agent turns are unchanged.",
      options: ["default", "lowest-latency"],
      experimental_schema: schema,
      default: "default",
    },
  });
  const normalize = (value: unknown) => schema.catch("default").parse(value);
  let routing = normalize((await settings.get()).nativeGenerationRouting);
  settings.onChange((next) => {
    routing = normalize(next.nativeGenerationRouting);
  });
  const status = registerPiAiService(bb, () => routing);
  bb.rpc.register(
    defineRpcContract({
      nativeGenerationStatus: {
        input: z.null(),
        output: z.object({
          requestedRouting: schema,
          last: z
            .object({
              model: z.string(),
              routingApplied: z.enum([
                "default",
                "lowest-latency",
                "inapplicable",
              ]),
            })
            .nullable(),
        }),
      },
    }),
    { nativeGenerationStatus: () => status() },
  );
  bb.cli.register(
    defineCli({
      name: "pi-generation",
      summary: "Inspect native Pi generation routing",
      commands: {
        status: cliCommand({
          summary: "Show requested routing and the last applied routing",
          run: () => ({ stdout: JSON.stringify(status()), exitCode: 0 }),
        }),
      },
    }),
  );
  const registered = bb.providers.register(piProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
