import { describe, expect, it, vi } from "vitest";
import { createCodexGenerationHandlers } from "./generation.js";
import { codexGenerationRespondMethod } from "./generation-contract.js";

const input = { hostId: "host_a", body: '{"model":"m"}', timeoutMs: 1000 };
const fromCodex = {
  experimental_caller: { kind: "plugin" as const, pluginId: "provider-codex" },
  experimental_signal: new AbortController().signal,
};

function handlers(
  overrides: Partial<Parameters<typeof createCodexGenerationHandlers>[0]> = {},
) {
  const handle = vi.fn(
    async (_request: Request, _route: string) =>
      new Response("data: done\n\n", { status: 200 }),
  );
  const tokenFor = vi.fn(async (hostId: string) => `token-for-${hostId}`);
  const respond = createCodexGenerationHandlers({
    basePath: "/api/v1/plugins/account-pool/http",
    canServe: async () => true,
    tokenFor,
    handle,
    ...overrides,
  })[codexGenerationRespondMethod];
  return { respond, handle, tokenFor };
}

describe("pooled Codex generation", () => {
  it("sends the request through the hub with the host's pool token", async () => {
    const { respond, handle, tokenFor } = handlers();
    await expect(respond(input, fromCodex)).resolves.toEqual({
      kind: "response",
      status: 200,
      body: "data: done\n\n",
    });
    expect(tokenFor).toHaveBeenCalledWith("host_a");
    const [request, route] = handle.mock.calls[0]!;
    expect(route).toBe("/v1/responses");
    expect(request.headers.get("x-bb-account-pool-token")).toBe(
      "token-for-host_a",
    );
    expect(await request.text()).toBe(input.body);
  });

  it("reports not-routed when no Codex account can serve", async () => {
    const { respond, handle } = handlers({ canServe: async () => false });
    await expect(respond(input, fromCodex)).resolves.toEqual({
      kind: "not-routed",
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("returns the status without the body of a failed answer", async () => {
    const { respond } = handlers({
      handle: async () => new Response("quota", { status: 429 }),
    });
    await expect(respond(input, fromCodex)).resolves.toEqual({
      kind: "response",
      status: 429,
      body: "",
    });
  });

  it("refuses every caller except the Codex provider", async () => {
    const { respond, handle } = handlers();
    await expect(
      respond(input, {
        ...fromCodex,
        experimental_caller: { kind: "plugin", pluginId: "other" },
      }),
    ).rejects.toThrow(/only the Codex provider/);
    await expect(
      respond(input, { ...fromCodex, experimental_caller: { kind: "client" } }),
    ).rejects.toThrow(/only the Codex provider/);
    expect(handle).not.toHaveBeenCalled();
  });
});
