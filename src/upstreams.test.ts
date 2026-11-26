import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "./claude-adapter.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { Account } from "./contracts.js";
import { PROVIDER_UPSTREAMS } from "./upstreams.js";

const MOUNT = "http://127.0.0.1:38886/api/v1/plugins/account-pool-prewarm/http";

function account(provider: Account["provider"], kind: Account["kind"]): Account {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider,
    kind,
    label: "test",
    email: null,
    accountUuid: null,
    ...(provider === "codex" && kind === "oauth"
      ? { codexAccountId: "chatgpt-account-1" }
      : {}),
    subscriptionType: null,
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: 0,
    lastUsedAt: null,
    lastUsedHostId: null,
  };
}

describe("Provider upstreams", () => {
  it("are the provider hosts", () => {
    expect(PROVIDER_UPSTREAMS).toEqual({
      anthropic: "https://api.anthropic.com",
      chatgptCodex: "https://chatgpt.com/backend-api/codex",
      openai: "https://api.openai.com/v1",
    });
    expect(Object.isFrozen(PROVIDER_UPSTREAMS)).toBe(true);
  });

  it("route Claude requests to the Anthropic API", () => {
    const claude = createClaudeAdapter({
      refreshUrl: "https://auth.example/token",
      usageUrl: "https://usage.example/usage",
      profileUrl: "https://profile.example/profile",
      upstreamBaseUrl: PROVIDER_UPSTREAMS.anthropic,
    });
    for (const kind of ["oauth", "api-key"] as const) {
      expect(
        claude
          .upstreamUrl(new Request(`${MOUNT}/v1/messages?beta=true`), account("claude", kind))
          .toString(),
      ).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(
        claude
          .upstreamUrl(new Request(`${MOUNT}/models`), account("claude", kind))
          .toString(),
      ).toBe("https://api.anthropic.com/v1/models");
    }
  });

  it("route Codex requests by account kind", () => {
    const codex = createCodexAdapter({
      refreshUrl: "https://auth.example/token",
      usageUrl: "https://usage.example/usage",
      chatgptBaseUrl: PROVIDER_UPSTREAMS.chatgptCodex,
      openaiBaseUrl: PROVIDER_UPSTREAMS.openai,
    });
    const request = new Request(`${MOUNT}/v1/responses`);
    expect(codex.upstreamUrl(request, account("codex", "oauth")).toString()).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(codex.upstreamUrl(request, account("codex", "api-key")).toString()).toBe(
      "https://api.openai.com/v1/responses",
    );
  });

  it.each([
    `${MOUNT}///evil.example/v1/messages`,
    `${MOUNT}/https://evil.example/v1/messages`,
  ])("refuse a request path that would change the host: %s", (url) => {
    const claude = createClaudeAdapter({
      refreshUrl: "https://auth.example/token",
      usageUrl: "https://usage.example/usage",
      profileUrl: "https://profile.example/profile",
      upstreamBaseUrl: PROVIDER_UPSTREAMS.anthropic,
    });
    const codex = createCodexAdapter({
      refreshUrl: "https://auth.example/token",
      usageUrl: "https://usage.example/usage",
      chatgptBaseUrl: PROVIDER_UPSTREAMS.chatgptCodex,
      openaiBaseUrl: PROVIDER_UPSTREAMS.openai,
    });
    const request = new Request(url);
    expect(() => claude.upstreamUrl(request, account("claude", "oauth"))).toThrow(
      "Upstream path must stay on the provider host.",
    );
    for (const kind of ["oauth", "api-key"] as const)
      expect(() => codex.upstreamUrl(request, account("codex", kind))).toThrow(
        "Upstream path must stay on the provider host.",
      );
  });
});
