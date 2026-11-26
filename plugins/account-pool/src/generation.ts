import {
  experimental_PluginRpcRefusal,
  type ExperimentalPluginRpcHandlersWithContext,
} from "@get-bb/plugin-sdk";
import {
  CODEX_GENERATION_CALLER,
  CODEX_GENERATION_MAX_BYTES,
  codexGenerationRespondMethod,
  type codexGenerationRespondContract,
} from "./generation-contract.js";

const RESPONSES_ROUTE = "/v1/responses";

export interface CodexGenerationDeps {
  readonly basePath: string;
  readonly canServe: () => Promise<boolean>;
  readonly tokenFor: (hostId: string) => Promise<string>;
  readonly handle: (request: Request, routePath: string) => Promise<Response>;
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > CODEX_GENERATION_MAX_BYTES)
        throw new Error("Codex response exceeds limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text + decoder.decode();
}

export function createCodexGenerationHandlers(
  deps: CodexGenerationDeps,
): ExperimentalPluginRpcHandlersWithContext<
  typeof codexGenerationRespondContract
> {
  return {
    [codexGenerationRespondMethod]: async (input, context) => {
      const caller = context.experimental_caller;
      if (
        caller.kind !== "plugin" ||
        caller.pluginId !== CODEX_GENERATION_CALLER
      )
        throw new experimental_PluginRpcRefusal({
          code: "forbidden",
          message: "only the Codex provider may use pooled generation",
        });
      if (!(await deps.canServe())) return { kind: "not-routed" as const };
      const token = await deps.tokenFor(input.hostId);
      const signal = AbortSignal.any([
        context.experimental_signal,
        AbortSignal.timeout(input.timeoutMs),
      ]);
      const request = new Request(
        `http://account-pool.local${deps.basePath}${RESPONSES_ROUTE}`,
        {
          method: "POST",
          headers: {
            "x-bb-account-pool-token": token,
            "content-type": "application/json",
            accept: "text/event-stream",
            originator: "bb",
          },
          body: input.body,
          signal,
        },
      );
      const response = await deps.handle(request, RESPONSES_ROUTE);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "response" as const, status: response.status, body: "" };
      }
      return {
        kind: "response" as const,
        status: response.status,
        body: await readCapped(response),
      };
    },
  };
}
