import { describe, expect, it } from "vitest";
import { assertDefaultCodexAiRoute } from "./catalog-policy.js";

describe("Codex direct-generation route binding", () => {
  it("allows the native default route and rejects custom provider configuration", () => {
    expect(() =>
      assertDefaultCodexAiRoute(
        { config: { model_provider: "openai", model_providers: {} } },
        {},
      ),
    ).not.toThrow();
    expect(() =>
      assertDefaultCodexAiRoute({ config: { model_provider: "custom" } }, {}),
    ).toThrow("Custom");
    expect(() =>
      assertDefaultCodexAiRoute(
        { config: { model_providers: { openai: { http_headers: {} } } } },
        {},
      ),
    ).toThrow("Custom");
  });
  it.each(["OPENAI_BASE_URL", "CODEX_API_KEY", "OPENAI_API_KEY"])(
    "rejects %s override without exposing its value",
    (key) => {
      expect(() =>
        assertDefaultCodexAiRoute(
          { config: {} },
          { [key]: "private-test-value" },
        ),
      ).toThrow(
        "Custom Codex provider routes are unsupported by text generation",
      );
    },
  );
});
