import * as mentions from "../../src/services/plugins/plugin-mentions.js";
import { getThreadSendIntakeService, startThreadSendIntakes, stopThreadSendIntakes } from "../../src/services/threads/thread-send-request.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { listQueuedThreadMessages, getThreadSendIntake } from "@bb/db";
import { sendAdmissionResponseSchema, sendMessageResponseSchema, threadSendIntakesResponseSchema } from "@bb/server-contract";
import { withTestHarness } from "../helpers/test-app.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import * as commands from "../../src/services/threads/thread-commands.js";
import * as dispatch from "../../src/services/threads/dispatch-attempt.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => vi.restoreAllMocks());

describe("send admission contract", () => {
  it("retains early custody until the actual app startup signal, independently of bounded provider readiness", async () => {
    await withTestHarness({ startSendIntakes: false, sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "stopping" } });
      const build = vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const id = randomUUID();
      const response = await h.app.request(`/api/v1/threads/${thread.id}/send-admission`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ admissionVersion: 1, clientSubmissionId: id, input: textInput("before plugins ready"), mode: "auto" }) });
      expect(response.status).toBe(200);
      await h.deps.providerRegistry.whenRegistrationsSettled();
      expect(build).not.toHaveBeenCalled();
      expect(getThreadSendIntake(h.db, `qsub_${id}`)).toMatchObject({ state: "pending", claimEpoch: 0 });
      h.startSendIntakes();
      await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
      expect(build).toHaveBeenCalledOnce();
      expect(getThreadSendIntake(h.db, `qsub_${id}`)?.state).toBe("transferred");
    });
  });

  it("negotiates accepted before held preparation while no-ID old ingress shares the lane", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "stopping" } });
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      const seen: string[] = [];
      const attemptDispatch = dispatch.attemptDispatch;
      vi.spyOn(dispatch, "attemptDispatch").mockImplementation((deps, args) => {
        const text = args.payload.input[0]; seen.push(text?.type === "text" ? text.text : "unknown");
        return attemptDispatch(deps, args);
      });
      let builds = 0;
      vi.spyOn(commands, "buildExecutionOptions").mockImplementation(async () => {
        if (++builds === 1) { entered.resolve(); await release.promise; }
        return execution;
      });
      const post = async (route: string, body: object) => h.app.request(`/api/v1/threads/${thread.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const id = randomUUID();
      try {
        const accepted = await post("send-admission", { admissionVersion: 1, clientSubmissionId: id, input: textInput("modern"), mode: "auto" });
        expect(accepted.status).toBe(200);
        const receipt = sendAdmissionResponseSchema.parse(await accepted.json());
        expect(receipt.admission.id).toBe(`qsub_${id}`);
        await entered.promise;
        let oldSettled = false;
        const old = post("send", { input: textInput("legacy"), mode: "auto" }).then(response => { oldSettled = true; return response; });
        const canonical = threadSendIntakesResponseSchema.parse(await (await h.app.request(`/api/v1/threads/${thread.id}/send-intakes`)).json());
        expect(canonical.admissionVersion).toBe(1);
        expect(canonical.rows[0]).toMatchObject({ id: receipt.admission.id, input: textInput("modern"), state: "preparing" });
        expect(seen).toEqual(["modern"]); expect(oldSettled).toBe(false);
        release.resolve();
        const legacy = await old;
        expect(legacy.status).toBe(200);
        expect(sendMessageResponseSchema.parse(await legacy.json()).delivery).toBe("queued");
        const queued = listQueuedThreadMessages(h.db, thread.id);
        expect(queued).toHaveLength(2);
        expect(queued[0]?.id).toBe(`qsub_${id}`);
        expect(queued[1]?.id).toMatch(/^qmsg_/);
        expect(queued.map(row => JSON.parse(row.content))).toEqual([textInput("modern"), textInput("legacy")]);
        expect(seen).toEqual(["modern", "legacy"]);
        expect(getThreadSendIntake(h.db, receipt.admission.id)?.state).toBe("transferred");
        const replay = await post("send-admission", { admissionVersion: 1, clientSubmissionId: id.toUpperCase(), input: textInput("modern"), mode: "auto" });
        expect(await replay.json()).toEqual(receipt);
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(2);
      } finally { release.resolve(); }
    });
  });

  it("rejects unsupported negotiation and exposes revision conflicts without losing custody", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "stopping" } });
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(commands, "buildExecutionOptions").mockImplementation(async () => { entered.resolve(); await release.promise; return execution; });
      const post = async (route: string, body: object) => h.app.request(`/api/v1/threads/${thread.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const id = randomUUID();
      try {
        const bad = await post("send-admission", { admissionVersion: 2, clientSubmissionId: id, input: textInput("bad"), mode: "auto" });
        expect(bad.status).toBe(400);
        const accepted = await post("send-admission", { admissionVersion: 1, clientSubmissionId: id, input: textInput("owned"), mode: "auto" });
        expect(accepted.status).toBe(200); await entered.promise;
        const row = getThreadSendIntake(h.db, `qsub_${id}`)!;
        const stale = await post("send-intakes/action", { id: row.id, revision: row.revision - 1, action: { kind: "cancel" } });
        expect(stale.status).toBe(409);
        expect(getThreadSendIntake(h.db, row.id)?.currentEnvelope).toContain("owned");
        const cancel = await post("send-intakes/action", { id: row.id, revision: row.revision, action: { kind: "cancel" } });
        expect(cancel.status).toBe(200);
        expect(getThreadSendIntake(h.db, row.id)?.state).toBe("cancelled");
        release.resolve();
        await vi.waitFor(() => expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0));
      } finally { release.resolve(); }
    });
  });
  it("keeps post-seal cancel/edit conflicts canonical and prevents late work after production stop", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h);
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      vi.spyOn(mentions, "resolvePluginMentionContextInputs").mockImplementation(async () => {
        entered.resolve(); await release.promise; return [];
      });
      const post = async (route: string, body: object) => h.app.request(`/api/v1/threads/${thread.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const id = randomUUID();
      try {
        const accepted = await post("send-admission", { admissionVersion: 1, clientSubmissionId: id, input: [{ type: "text", text: "@ref sealed original", mentions: [{ start: 0, end: 4, resource: { kind: "plugin", pluginId: "test-mention", itemId: "ref", label: "ref" } }] }], mode: "auto" });
        expect(accepted.status).toBe(200); await entered.promise;
        const row = getThreadSendIntake(h.db, `qsub_${id}`)!;
        expect(row.sealedAt).not.toBeNull();
        for (const action of [{ kind: "cancel" }, { kind: "edit", input: textInput("replacement") }]) {
          const conflict = await post("send-intakes/action", { id: row.id, revision: row.revision, action });
          expect(conflict.status).toBe(409);
          expect(getThreadSendIntake(h.db, row.id)?.currentEnvelope).toContain("sealed original");
        }
        stopThreadSendIntakes(h.deps, true);
        startThreadSendIntakes(h.deps);
        expect(() => getThreadSendIntakeService(h.deps)).toThrow(/stopped/);
        expect(getThreadSendIntake(h.db, row.id)).toMatchObject({ state: "failed", admissionReceipt: expect.any(String) });
      } finally { stopThreadSendIntakes(h.deps, true); release.resolve(); }
    });
  });

});
