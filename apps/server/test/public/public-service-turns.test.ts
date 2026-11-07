import { describe, expect, it, vi } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import { createNodeBbSdk } from "@bb/sdk/node";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { getThread, insertThreadPluginMetadata } from "@bb/db";

it("keeps a hidden delivery discoverable by the raw 2a event probe while its timeline is empty", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps),
      { project } = seedProjectWithSource(h.deps, { hostId: host.id });
    const environment = seedEnvironment(h.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(h.deps, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
    const requestId = encodeClientTurnRequestIdNumber({ value: 1 });
    seedEvent(h.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 1,
      type: "client/turn/requested",
      scope: threadScope(),
      data: {
        direction: "outbound",
        requestId,
        serviceTurn: {
          version: 1,
          visibility: "hidden",
          reason: "helper-result",
          origin: { pluginId: "wprojects", senderThreadId: null },
        },
        input: [{ type: "text", text: "private service input", mentions: [] }],
        target: { kind: "new-turn" },
        execution: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          source: "client/turn/requested",
        },
        initiator: "system",
        senderThreadId: null,
        request: { method: "turn/start", params: {} },
        source: "tell",
      },
    });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider",
      sequence: 2,
      turnId: "service",
    });
    seedEvent(h.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider",
      sequence: 3,
      type: "turn/input/accepted",
      scope: turnScope("service"),
      data: { providerThreadId: "provider", clientRequestId: requestId },
    });
    seedEvent(h.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: "provider",
      sequence: 4,
      type: "item/completed",
      scope: turnScope("service"),
      data: {
        providerThreadId: "provider",
        item: {
          type: "agentMessage",
          id: "reply",
          text: "private service reply",
        },
      },
    });
    const sdk = createNodeBbSdk({
      baseUrl: "http://localhost",
      fetch: async (input, init) => h.app.request(new Request(input, init)),
    });
    const raw = await sdk.threads.events.list({
      threadId: thread.id,
      order: "asc",
      limit: "100",
    });
    expect(
      raw.some(
        (row) =>
          row.type === "turn/input/accepted" &&
          row.data.clientRequestId === requestId,
      ),
    ).toBe(true);
    expect(
      raw.some(
        (row) =>
          row.type === "item/completed" &&
          row.data.item.type === "agentMessage" &&
          row.data.item.text === "private service reply",
      ),
    ).toBe(true);
    expect((await sdk.threads.timeline({ threadId: thread.id })).rows).toEqual(
      [],
    );
    expect(
      (
        await sdk.threads.timeline({
          threadId: thread.id,
          includeService: "true",
        })
      ).rows.length,
    ).toBeGreaterThan(0);
    const before = getThread(h.db, thread.id)!.latestAttentionAt;
    applyLoggedThreadLifecycleEvent(h.deps, {
      threadId: thread.id,
      event: { type: "run.failed" },
    });
    expect(getThread(h.db, thread.id)).toMatchObject({
      status: "error",
      latestAttentionAt: before,
    });
    expect((await sdk.threads.get({ threadId: thread.id })).status).toBe(
      "error",
    );
  });
});

describe("service admission", () => {
  it("refuses a descriptor forged by an ordinary client", async () =>
    withTestHarness(async (h) => {
      const { host } = seedHostSession(h.deps),
        { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const thread = seedThread(h.deps, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      const response = await h.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "ordinary wording" }],
            mode: "auto",
            serviceTurn: {
              version: 1,
              visibility: "hidden",
              reason: "self-reminder",
              origin: { pluginId: "wprojects", senderThreadId: null },
            },
          }),
        },
      );
      expect(response.status).toBe(403);
    }));
  it("accepts authenticated managed input and rejects foreign senders", async () =>
    withTestHarness(async (h) => {
      const { host } = seedHostSession(h.deps),
        { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const environment = seedEnvironment(h.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(h.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });
      insertThreadPluginMetadata(h.db, {
        threadId: thread.id,
        pluginId: "wprojects",
        metadata: { projectChild: true },
      });
      vi.spyOn(h.pluginService, "resolveRpcCaller").mockReturnValue({
        ok: true,
        caller: { kind: "plugin", pluginId: "wprojects" },
      });
      const send = (senderThreadId: string | null) =>
        h.app.request(`/api/v1/threads/${thread.id}/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bb-plugin-caller": "fixture",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "arbitrary wording" }],
            mode: "auto",
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            ...(senderThreadId ? { senderThreadId } : {}),
            serviceTurn: {
              version: 1,
              visibility: "hidden",
              reason: "future-rotation-seed",
              origin: { pluginId: "wprojects", senderThreadId },
            },
          }),
        });
      expect((await send("foreign")).status).toBe(403);
      const response = await send(null);
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        delivery: "queued",
        queuedMessage: { serviceTurn: { reason: "future-rotation-seed" } },
      });
    }));
});

it("allocates an empty plugin thread without dispatching a visible bootstrap", async () =>
  withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps),
      { project } = seedProjectWithSource(h.deps, { hostId: host.id });
    const response = await h.app.request("/api/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        origin: "plugin",
        originPluginId: "wprojects",
        pluginMetadata: { coordinator: true },
        input: [],
        title: "Project chat",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: "/tmp/test-project" },
        },
      }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ status: "pending" });
    const events = await h.app.request(`/api/v1/threads/${body.id}/events`);
    expect(await events.json()).toEqual([]);
  }));
