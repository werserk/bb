import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { NativeClients } from "./native-pool.js";
import { nativeHostContract } from "./native-host-contract.js";
// This adapter is source-qualified only. Production policy remains disabled.
export function createNativeClients(bb: BbPluginApi): NativeClients {
  const host = bb.hosts.experimental_client({ contract: nativeHostContract });
  return {
    enrolledHost: async (hostId) =>
      (await bb.sdk.hosts.list()).some((h) => h.id === hostId),
    observe: (cell) =>
      host.call("status", null, { hostId: cell.hostId, timeoutMs: 5000 }),
    async spawn(i) {
      if (typeof bb.sdk.threads.experimental_releaseIdle !== "function")
        throw new Error(
          "Matching native-pool core prerequisite is unavailable",
        );
      const thread = await bb.sdk.threads.spawn({
        projectId: i.projectId,
        providerId: "claude-code",
        input: [],
        originKind: null,
        pluginMetadata: i.pluginMetadata,
        environment: {
          type: "host",
          hostId: i.hostId,
          workspace: { type: "unmanaged", path: i.workspace },
        },
      });
      return { threadId: thread.id };
    },
    async send(threadId, input) {
      const result = await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: input, mentions: [] }],
        mode: "auto",
      });
      return result.delivery === "queued"
        ? { kind: "queued", queueId: result.queuedMessage.id }
        : { kind: "sent" };
    },
    async recheck() {
      await bb.experimental_hooks.recheck("message.dispatch");
    },
    async findCreated(i) {
      const candidates = [];
      for (let offset = 0; ; offset += 200) {
        const rows = await bb.sdk.threads.list({
          projectId: i.projectId,
          includeHidden: true,
          limit: 200,
          offset,
        });
        if (rows.length) {
          const metadata = await bb.sdk.threads.experimental_listPluginMetadata(
            { pluginId: bb.pluginId, threadIds: rows.map((t) => t.id) },
          );
          for (const row of metadata.threads) {
            const parsed = z
              .object({
                nativePool: z.object({
                  operationId: z.string(),
                  cellId: z.string(),
                  accountGeneration: z.string(),
                }),
              })
              .safeParse(row.metadata);
            if (parsed.success && parsed.data.nativePool.operationId === i.id)
              candidates.push({
                threadId: row.threadId,
                cellId: parsed.data.nativePool.cellId,
                generation: parsed.data.nativePool.accountGeneration,
              });
          }
        }
        if (rows.length < 200) break;
      }
      return candidates;
    },
    async releaseIdle(threadId) {
      return (await bb.sdk.threads.experimental_releaseIdle({ threadId }))
        .status;
    },
    async stop(threadId) {
      await bb.sdk.threads.stop({ threadId });
    },
    async cancelQueue(threadId, queueId) {
      await bb.sdk.threads.queuedMessages.delete({
        threadId,
        queuedMessageId: queueId,
      });
    },
  };
}
