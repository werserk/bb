import { expect, it } from "vitest";
import type { OpenCodeGoGenerationRequest } from "./contract.js";
import { createOpenCodeGoRuntime, openCodeGoBody, parseOpenCodeGoToken } from "./go-runtime.js";

const request: OpenCodeGoGenerationRequest = {
  model: "claude-haiku-5-5",
  messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }],
  maxOutputTokens: null, temperature: null, reasoningEffort: null,
  serviceTier: null, experimental_sessionAffinity: "thread-affinity", timeoutMs: 1000,
};
const credential = { integrationID: "opencode", active: true, value: { type: "oauth", access: "synthetic-secret", expires: 2000 } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("reads the active OpenCode sign-in and refuses an expired one", () => {
  expect(parseOpenCodeGoToken([credential, { ...credential, integrationID: "openrouter" }], 1000)).toBe("synthetic-secret");
  expect(() => parseOpenCodeGoToken([credential], 3000)).toThrow("expired");
  expect(() => parseOpenCodeGoToken([{ ...credential, value: { type: "key", key: "x" } }], 1000)).toThrow("OpenCode Go request failed");
});

it("rejects a service tier the subscription does not have", () => {
  expect(() => openCodeGoBody({ ...request, serviceTier: "fast" })).toThrow("no service tiers");
});

it("lists models and generates with a session header and user agent", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const runtime = createOpenCodeGoRuntime({
    key: async () => "synthetic-secret",
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/models")
        ? json({ data: [{ id: "claude-haiku-5-5" }] })
        : json({ model: "claude-haiku-5-5", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK", reasoning_content: "x" } }] });
    }) as typeof fetch,
  });
  const signal = new AbortController().signal;
  expect(await runtime.models(signal)).toEqual([
    { id: "claude-haiku-5-5", displayName: "claude-haiku-5-5", maxOutputTokens: true, temperature: true, reasoningEfforts: [] },
  ]);
  expect(await runtime.generate(request, signal)).toMatchObject({ text: "OK", finishReason: "stop" });
  const headers = calls[1]?.init?.headers as Record<string, string>;
  expect(headers["x-opencode-session"]).toBe("thread-affinity");
  expect(headers["User-Agent"]).toContain("opencode-go");
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ model: "claude-haiku-5-5", messages: request.messages, stream: false });
});

it("reports a rate limit as unavailable without the token", async () => {
  const runtime = createOpenCodeGoRuntime({
    key: async () => "synthetic-secret",
    fetch: (async () => json({ error: "synthetic-secret" }, 429)) as typeof fetch,
  });
  const error = await runtime.generate(request, new AbortController().signal).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "unavailable", message: "OpenCode Go HTTP 429" });
});
