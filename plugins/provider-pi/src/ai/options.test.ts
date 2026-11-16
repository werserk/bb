import { expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { resolvePiOptions } from "./options.js";

const model: Model<"openai-completions"> = {
  id: "vendor/model",
  name: "Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 4096,
};
const request = {
  model: "openrouter/vendor/model",
  messages: [{ role: "user" as const, content: "test" }],
  maxOutputTokens: null,
  temperature: null,
  reasoningEffort: null,
  serviceTier: null,
  experimental_sessionAffinity: null,
  routing: "lowest-latency" as const,
  timeoutMs: 1000,
};

it("does not advertise or silently clamp unsupported reasoning levels", () => {
  const limited = {
    ...model,
    thinkingLevelMap: { off: null, low: null, xhigh: null },
  };
  const capabilities = resolvePiOptions(limited).capabilities;
  expect(capabilities.reasoningEfforts).not.toContain("none");
  expect(capabilities.reasoningEfforts).not.toContain("low");
  expect(capabilities.reasoningEfforts).not.toContain("xhigh");
  for (const reasoningEffort of ["none", "low", "xhigh", "ultra"])
    expect(() =>
      resolvePiOptions(limited, { ...request, reasoningEffort }),
    ).toThrow("Unsupported");
  expect(
    resolvePiOptions(limited, { ...request, reasoningEffort: "high" }).options
      .reasoning,
  ).toBe("high");
});

it.each([
  { ...model, provider: "other" },
  { ...model, baseUrl: "https://other.invalid/api/v1" },
  { ...model, reasoning: false },
])("retains native behavior outside supported reasoning routes", (selected) => {
  expect(resolvePiOptions(selected).capabilities.reasoningEfforts).toEqual([]);
  if (selected.provider !== "openrouter" || selected.baseUrl !== model.baseUrl)
    expect(resolvePiOptions(selected, request).model).toBe(selected);
});

it.each([
  { sendSessionAffinityHeaders: false },
  { sessionAffinityFormat: "openai" as const },
])("rejects incompatible affinity metadata", (compat) => {
  const selected = { ...model, compat };
  expect(
    resolvePiOptions(selected).capabilities.experimental_sessionAffinity,
  ).toBe(false);
  expect(() =>
    resolvePiOptions(selected, {
      ...request,
      experimental_sessionAffinity: "thread",
    }),
  ).toThrow("Unsupported session");
});
