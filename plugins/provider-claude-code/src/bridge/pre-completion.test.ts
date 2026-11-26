import { expect, it } from "vitest";
import { checkNativePreCompletion } from "./pre-completion.js";

it("returns one native Stop block from a bounded core response", async () => {
  let received: unknown;
  const response = await checkNativePreCompletion({
    finalText: "x".repeat(9000),
    signal: new AbortController().signal,
    request: async (input) => {
      received = input;
      return {
        content: JSON.stringify({
          action: "continue",
          instruction: "Use the native question tool.",
        }),
      };
    },
  });
  expect(received).toEqual({ finalText: "x".repeat(8192), truncated: true });
  expect(response).toEqual({
    decision: "block",
    reason: "Use the native question tool.",
  });
});
it("owner Stop wins over an outstanding policy response", async () => {
  const controller = new AbortController();
  const response = checkNativePreCompletion({
    finalText: "need input",
    signal: controller.signal,
    request: () => new Promise(() => {}),
  });
  controller.abort();
  expect(await response).toEqual({ continue: true });
});
it("fails open for old hosts, unavailable transport and malformed replies", async () => {
  for (const request of [
    async () => ({ content: "Unsupported tool" }),
    async () => {
      throw new Error("offline");
    },
    async () => ({
      content: JSON.stringify({
        action: "continue",
        instruction: "x".repeat(1001),
      }),
    }),
  ]) {
    expect(
      await checkNativePreCompletion({
        finalText: "need input",
        signal: new AbortController().signal,
        request,
      }),
    ).toEqual({ continue: true });
  }
});
