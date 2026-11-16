import { describe, expect, it } from "vitest";
import { experimental_AI_MODEL_ID_MAX_LENGTH } from "@get-bb/plugin-sdk";
import {
  BodyError,
  MAX_BODY_BYTES,
  chatResponse,
  chatSchema,
  generationRequest,
  readBoundedJson,
} from "./chat.js";
const minimal = {
  model: "provider/service/host/model",
  messages: [{ role: "user", content: "Hello" }],
};
describe("OpenAI text boundary", () => {
  it("retains message roles and explicit controls", () => {
    const parsed = chatSchema.parse({
      ...minimal,
      max_completion_tokens: 42,
      temperature: 0,
    });
    expect(generationRequest(parsed)).toMatchObject({
      model: minimal.model,
      messages: minimal.messages,
      maxOutputTokens: 42,
      temperature: 0,
      reasoningEffort: null,
    });
  });
  it.each([
    { stream: true },
    { tools: [] },
    { n: 2 },
    { response_format: { type: "json_object" } },
    { max_tokens: 3, max_completion_tokens: 4 },
    { unknown_option: 1 },
    {
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    },
  ])("rejects unsupported requests before dispatch", (extra) => {
    expect(chatSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
  });
  it("preserves text and omits unknown usage", () => {
    const result = chatResponse({
      text: "line 1\nline 2",
      model: minimal.model,
      actualModel: null,
      finishReason: "length",
      usage: null,
    });
    expect(result.choices[0]).toMatchObject({
      message: { content: "line 1\nline 2" },
      finish_reason: "length",
    });
    expect(result).not.toHaveProperty("usage");
  });
  it("returns provider-reported model identity without rewriting the selected alias", () => {
    const result = {
      text: "ok",
      model: minimal.model,
      actualModel: "native-version-2026",
      finishReason: "stop" as const,
      usage: null,
    };
    expect(chatResponse(result).model).toBe("native-version-2026");
    expect(result.model).toBe(minimal.model);
  });
  it("accepts the shared model ID limit and rejects one byte beyond it", () => {
    expect(
      chatSchema.safeParse({
        ...minimal,
        model: "m".repeat(experimental_AI_MODEL_ID_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      chatSchema.safeParse({
        ...minimal,
        model: "m".repeat(experimental_AI_MODEL_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
  it("reports only actual token measurements", () => {
    expect(
      chatResponse({
        text: "ok",
        model: minimal.model,
        actualModel: null,
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 8 },
      }).usage,
    ).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 8 },
    });
  });
  it("rejects oversized bodies without trusting content length", async () => {
    const request = new Request("http://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_BODY_BYTES + 1),
    });
    await expect(readBoundedJson(request)).rejects.toMatchObject({
      status: 413,
    });
  });
  it("rejects malformed JSON without echoing its contents", async () => {
    await expect(
      readBoundedJson(
        new Request("http://example.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "SECRET",
        }),
      ),
    ).rejects.toEqual(new BodyError(400, "Invalid JSON body"));
  });
  it("aborts a stalled upload without waiting for more bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    };
    const request = new Request("http://example.test", init);
    const controller = new AbortController();
    const pending = readBoundedJson(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      message: "Request cancelled",
    });
    expect(cancelled).toBe(true);
  });
});
