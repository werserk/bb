import { listQueuedThreadMessages } from "@bb/db";
import type { ThreadQueuedMessage } from "@bb/domain";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { listEvents } from "@bb/db/testing";

const WORKSPACE_PATH = "/tmp/fork-run-on-send-later";
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

function installHooks(
  handlers: PluginHookRegistration<"message.dispatch">[],
): void {
  const registry: { [K in PluginHookName]: PluginHookRegistration<K>[] } = {
    "message.dispatch": handlers,
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

describe("Run on account chip with Send later", () => {
  it("hands a pool-shaped submission to the inline pass before the time row exists", async () => {
    await withTestHarness(async (harness) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const sendAt = Date.now() + DAY_MS;
      const pluginSubmission = {
        pluginId: "account-pool",
        data: {
          policy: { mode: "named", accountId: "acct-1", onLimit: "stop" },
        },
      };
      const writes: {
        threadId: string;
        policy: unknown;
        rowsAtWrite: number;
      }[] = [];
      installHooks([
        {
          pluginId: "account-pool",
          handler: (context) => {
            const submission = context.experimental_submission;
            if (submission?.pluginId !== "account-pool") {
              return { action: "proceed" };
            }
            writes.push({
              threadId: context.thread.id,
              policy: (submission.data as { policy: unknown }).policy,
              rowsAtWrite: listQueuedThreadMessages(
                harness.db,
                context.thread.id,
              ).length,
            });
            return { action: "proceed" };
          },
        },
      ]);
      const { host } = seedHostSession(harness.deps, {
        id: "host-run-on-send-later",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: WORKSPACE_PATH,
      });

      const thread = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: WORKSPACE_PATH },
        },
        input: textInput("tomorrow on the worker"),
        origin: "app",
        pluginSubmission,
        projectId: project.id,
        providerId: "codex",
        sendAt,
        startedOnBehalfOf: null,
      });

      expect(writes).toEqual([
        {
          threadId: thread.id,
          policy: pluginSubmission.data.policy,
          rowsAtWrite: 0,
        },
      ]);
      const rows: ThreadQueuedMessage[] = listQueuedThreadMessages(
        harness.db,
        thread.id,
      ).map(toThreadQueuedMessage);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.waitingOn).toEqual({ kind: "time" });
      expect(rows[0]?.sendAt).toBe(sendAt);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "client/turn/requested",
        ),
      ).toHaveLength(0);
    });
  });
});
