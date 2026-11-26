import { createHelperService } from "./helper-service.js";
import { emptyTaskState, type TaskMemory } from "./task-state.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createService } from "./controller.js";
import {
  helperRequestSchema,
  helperResultSchema,
  type HelperRequest,
} from "./helper.js";
import { fixture } from "./test-fixtures.js";
import { installGenerator } from "./generator-fixture.js";
import { settingsSchema } from "./settings.js";
import plugin from "../server.js";

const input = (): HelperRequest => ({
  threadId: "thread",
  requestId: randomUUID(),
  token: randomUUID(),
  draft: "Fix this, preserving scope.",
  protectedMentions: [],
});
const answer = {
  kind: "helper",
  text: "Fix the issue while preserving the agreed scope.",
  advice: "Consider asking for the missing reproduction.",
};

it("shares the helper across RPC/CLI with auto off, full BIBLE, separate advice and independent output budget", async () => {
  const host = fixture({ interaction: "question" });
  const owner = "# BIBLE\n" + "Do not infer owner permission.\n".repeat(1000);
  host.bb.experimental_userInstructions.read = () => ({
    kind: "ready",
    content: owner,
    revision: "bible",
  });
  const model = await installGenerator(host.bb, async (request) => {
    expect(request.maxOutputTokens).toBeNull();
    expect(request.messages[0]?.content).toContain(owner);
    expect(request.messages[0]?.content).toContain(
      "NOT an accepted instruction",
    );
    expect(request.messages[1]?.content).toContain('"unsentDraft"');
    return JSON.stringify(answer);
  });
  try {
    await plugin(host.bb);
    await host.harness.behavior.setSettings({
      model,
      enabled: false,
      outputTokenLimit: 128,
    });
    const snapshot = await host.harness.behavior.callRpc("helperContext", {
      threadId: "thread",
    });
    expect(snapshot).toMatchObject({ revision: expect.any(String) });
    expect(
      await host.harness.behavior.callRpc("helper", input()),
    ).toMatchObject(answer);
    const cli = await host.harness.behavior.runCli([
      "helper",
      "--thread",
      "thread",
      "--draft",
      "Fix it",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject(answer);
    expect(host.harness.inspection.logEntries).toEqual([]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("rejects oversized drafts, unknown fields and forged mention maps before dispatch", () => {
  expect(
    helperRequestSchema.safeParse({ ...input(), draft: "💡".repeat(12001) })
      .success,
  ).toBe(false);
  expect(
    helperRequestSchema.safeParse({ ...input(), ignored: true }).success,
  ).toBe(false);
  expect(
    helperRequestSchema.safeParse({ ...input(), draft: "<<BB_MENTION_bad_0>>" })
      .success,
  ).toBe(false);
  expect(
    helperResultSchema.safeParse({ ...answer, text: "x".repeat(16001) })
      .success,
  ).toBe(false);
  expect(
    helperResultSchema.safeParse({ ...answer, advice: "x".repeat(2001) })
      .success,
  ).toBe(false);
  expect(
    helperResultSchema.safeParse({ ...answer, approval: true }).success,
  ).toBe(false);
  expect(
    helperResultSchema.safeParse({ ...answer, text: "x".repeat(601) }).success,
  ).toBe(true);
});

it("handles no-history drafts and avoids inference for an empty unsupported next step", async () => {
  const host = fixture({ noHistory: true });
  let calls = 0;
  const model = await installGenerator(host.bb, async () => {
    calls++;
    return JSON.stringify(answer);
  });
  const service = createService(host.bb, () => settingsSchema.parse({ model }));
  try {
    expect(await service.helper({ ...input(), draft: "" })).toMatchObject({
      kind: "none",
      contextRevision: expect.any(String),
    });
    expect(calls).toBe(0);
    expect(await service.helper(input())).toMatchObject(answer);
    expect(calls).toBe(1);
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});

it("accepts active thread context without waiting for completion", async () => {
  const host = fixture({ threadStatus: "active" });
  const model = await installGenerator(host.bb, async () =>
    JSON.stringify(answer),
  );
  const service = createService(host.bb, () => settingsSchema.parse({ model }));
  try {
    expect(await service.helper(input())).toMatchObject(answer);
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});

it.each(["cancel", "caller", "reset", "dispose"])(
  "rejects late helper results after %s",
  async (change) => {
    const options: { contextBoundary?: number } = {};
    const host = fixture(options);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = await installGenerator(host.bb, async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return JSON.stringify(answer);
    });
    let settings = settingsSchema.parse({ model });
    const service = createService(host.bb, () => settings);
    const request = input();
    const caller = new AbortController();
    try {
      const pending = service.helper(request, caller.signal);
      await began;
      if (change === "context") {
        options.contextBoundary = 2;
      } else if (change === "instructions")
        host.bb.experimental_userInstructions.read = () => ({
          kind: "ready",
          content: "New owner instruction",
          revision: "new",
        });
      else if (change === "settings")
        settings = { ...settings, instructions: "New guidance" };
      else if (change === "cancel") {
        expect(service.cancel(request.requestId, "wrong")).toBe(false);
        expect(service.cancel(request.requestId, request.token)).toBe(true);
      } else if (change === "caller") caller.abort();
      else if (change === "reset") service.reset();
      else service.dispose();
      release();
      expect(await pending).toMatchObject({ kind: "unavailable" });
    } finally {
      service.dispose();
      await host.harness.lifecycle.dispose();
    }
  },
);

it("retains shared admission after clear/reset without resetting its rate limit", async () => {
  const host = fixture();
  let calls = 0;
  const model = await installGenerator(host.bb, async () => {
    calls++;
    return JSON.stringify(answer);
  });
  const service = createService(host.bb, () =>
    settingsSchema.parse({ model, enabled: true, maxRequestsPerHour: 1 }),
  );
  try {
    expect(await service.helper(input())).toMatchObject(answer);
    service.clearCache("thread");
    service.reset();
    expect(await service.helper(input())).toEqual({
      kind: "unavailable",
      reason: "rate_limited",
    });
    expect(
      await service.suggest({
        threadId: "thread",
        requestId: "suggest",
        token: "token",
        automatic: false,
        expectedTurnId: null,
      }),
    ).toEqual({ kind: "unavailable", reason: "rate_limited" });
    expect(calls).toBe(1);
    expect(service.diagnostics()).toMatchObject({
      admitted: 1,
      requests: 1,
      helper: { requests: 1, completed: 1 },
    });
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});

it.each(["missing", "duplicated", "fabricated", "advice", "valid"])(
  "validates protected mention identity: %s",
  async (kind) => {
    const host = fixture();
    const request = input();
    const token = `<<BB_MENTION_${request.requestId}_0>>`;
    request.draft = `Fix ${token}`;
    request.protectedMentions = [token];
    const text =
      kind === "missing"
        ? "Fix it"
        : kind === "duplicated"
          ? `${token} ${token}`
          : kind === "fabricated"
            ? `${token} <<BB_MENTION_forged_0>>`
            : `Please fix ${token}`;
    const model = await installGenerator(host.bb, async () =>
      JSON.stringify({
        kind: "helper",
        text,
        advice: kind === "advice" ? token : null,
      }),
    );
    const service = createService(host.bb, () =>
      settingsSchema.parse({ model }),
    );
    try {
      expect(await service.helper(request)).toMatchObject(
        kind === "valid"
          ? { kind: "helper", text }
          : { kind: "unavailable", reason: "invalid_mentions" },
      );
    } finally {
      service.dispose();
      await host.harness.lifecycle.dispose();
    }
  },
);

it.each(["length", "stop"] as const)(
  "handles incomplete or invalid JSON output (%s) without retry",
  async (finish) => {
    const host = fixture();
    let calls = 0;
    const model = await installGenerator(
      host.bb,
      async () => {
        calls++;
        return "{";
      },
      finish,
    );
    const service = createService(host.bb, () =>
      settingsSchema.parse({ model }),
    );
    try {
      expect(await service.helper(input())).toMatchObject({
        kind: "unavailable",
        reason: finish === "length" ? "output_truncated" : "generation_failed",
      });
      expect(calls).toBe(1);
    } finally {
      service.dispose();
      await host.harness.lifecycle.dispose();
    }
  },
);

it("blocks approvals and unavailable configuration without inference", async () => {
  const host = fixture({ interaction: "approval" });
  let calls = 0;
  const model = await installGenerator(host.bb, async () => {
    calls++;
    return JSON.stringify(answer);
  });
  let settings = settingsSchema.parse({ model });
  const service = createService(host.bb, () => settings);
  try {
    expect(await service.helper(input())).toEqual({
      kind: "unavailable",
      reason: "ineligible",
    });
    settings = { ...settings, model: "" };
    expect(await service.helper(input())).toEqual({
      kind: "unavailable",
      reason: "not_configured",
    });
    expect(calls).toBe(0);
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});

it("times out helper generation and releases the local helper lane without retries", async () => {
  const host = fixture();
  let calls = 0;
  const model = await installGenerator(host.bb, async (_request, signal) => {
    calls++;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
    return JSON.stringify(answer);
  });
  const service = createService(host.bb, () =>
    settingsSchema.parse({ model, timeoutMs: 100 }),
  );
  try {
    expect(await service.helper(input())).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
    expect(service.diagnostics()).toMatchObject({
      helper: { active: 0, errors: 1 },
    });
    expect(calls).toBe(1);
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});

it.each(["message", "memory"])(
  "returns its snapshot proposal when %s changes during generation",
  async (change) => {
    const options = { assistantText: "Before generation" };
    const host = fixture(options);
    let memory: TaskMemory | null = null;
    const model = await installGenerator(host.bb, async () => {
      if (change === "message")
        options.assistantText = "New assistant message during generation";
      else
        memory = {
          state: { ...emptyTaskState(), contextComplete: true },
          sources: [],
          boundary: null,
        };
      return JSON.stringify(answer);
    });
    const service = createHelperService(
      host.bb,
      () => settingsSchema.parse({ model }),
      {
        inspect: () => memory,
        beginHelper: () => ({ admit: () => true, finish: () => undefined }),
      },
    );
    try {
      const before = await service.context("thread");
      const result = await service.generate(input());
      expect(result).toMatchObject({
        ...answer,
        contextRevision: before.revision,
      });
      expect((await service.context("thread")).revision).not.toBe(
        before.revision,
      );
    } finally {
      service.dispose();
      await host.harness.lifecycle.dispose();
    }
  },
);
