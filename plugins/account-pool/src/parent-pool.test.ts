import { describe, expect, it, vi } from "vitest";
import {
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
  ParentAvailability,
  parentRequestHeaders,
  readParentPool,
} from "./parent-pool.js";

const TOKEN = "vqMIj4xUiI3PyvKS2SllSKHsOfxLF_sAZwzNAAvV9TQ";
const BASE_URL = "http://127.0.0.1:38886/api/v1/plugins/account-pool/http";

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    [PARENT_URL_ENV]: BASE_URL,
    [PARENT_TOKEN_ENV]: TOKEN,
    ...overrides,
  };
}

describe("readParentPool", () => {
  it("reads a well formed marker and strips trailing slashes", () => {
    expect(readParentPool(env({ [PARENT_URL_ENV]: `${BASE_URL}//` }))).toEqual({
      baseUrl: BASE_URL,
      token: TOKEN,
    });
  });

  const rejected: Array<{ label: string; overrides: Record<string, string> }> =
    [
      { label: "absent url", overrides: { [PARENT_URL_ENV]: "" } },
      { label: "relative url", overrides: { [PARENT_URL_ENV]: "/pool" } },
      {
        label: "non-http url",
        overrides: { [PARENT_URL_ENV]: "ftp://host/p" },
      },
      { label: "short token", overrides: { [PARENT_TOKEN_ENV]: "too-short" } },
      {
        label: "token with illegal characters",
        overrides: { [PARENT_TOKEN_ENV]: `${TOKEN.slice(0, 42)}$` },
      },
    ];

  it.each(rejected)(
    "rejects a $label rather than half configuring proxying",
    (args) => {
      expect(readParentPool(env(args.overrides))).toBeNull();
    },
  );

  it("reads nothing when the marker is absent entirely", () => {
    expect(readParentPool({})).toBeNull();
  });
});

describe("parentRequestHeaders", () => {
  it("replaces inbound credentials with the parent token and keeps the rest", () => {
    const headers = parentRequestHeaders(
      new Headers({
        authorization: "Bearer child-token",
        "x-api-key": "child-key",
        "x-bb-account-pool-token": "child-hub-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      }),
      TOKEN,
    );
    expect(headers.get("x-bb-account-pool-token")).toBe(TOKEN);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });
});

describe("ParentAvailability", () => {
  function availability(args: {
    fetchImpl: typeof fetch;
    now?: () => number;
  }): ParentAvailability {
    return new ParentAvailability({
      parent: { baseUrl: BASE_URL, token: TOKEN },
      fetch: args.fetchImpl,
      now: args.now ?? (() => 0),
      ttlMs: 1_000,
    });
  }

  it("reads the parent booleans and presents the hub token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ claude: true, codex: false }),
    ) as unknown as typeof fetch;
    await expect(availability({ fetchImpl }).get()).resolves.toEqual({
      claude: true,
      codex: false,
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      `${BASE_URL}/availability`,
    );
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(
      (init?.headers as Record<string, string>)["x-bb-account-pool-token"],
    ).toBe(TOKEN);
  });

  it("fails closed when the parent is unreachable", async () => {
    const onError = vi.fn();
    const client = new ParentAvailability({
      parent: { baseUrl: BASE_URL, token: TOKEN },
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      now: () => 0,
      onError,
    });
    await expect(client.get()).resolves.toEqual({
      claude: false,
      codex: false,
    });
    expect(onError).toHaveBeenCalled();
  });

  it("fails closed when the parent rejects the token", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(availability({ fetchImpl }).get()).resolves.toEqual({
      claude: false,
      codex: false,
    });
  });

  it("fails closed when the parent returns an unexpected body", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ claude: "yes" }),
    ) as unknown as typeof fetch;
    await expect(availability({ fetchImpl }).get()).resolves.toEqual({
      claude: false,
      codex: false,
    });
  });

  it("caches within the ttl and refetches once it lapses", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ claude: true, codex: true }),
    ) as unknown as typeof fetch;
    let clock = 0;
    const client = availability({ fetchImpl, now: () => clock });
    await client.get();
    await client.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = 1_001;
    await client.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("keeps the last route across a timeout without caching false availability", async () => {
    let clock = 0;
    let failed = false;
    const fetchImpl = vi.fn(async () => {
      if (failed) throw new DOMException("synthetic timeout", "TimeoutError");
      return Response.json({ claude: true, codex: false });
    });
    const client = new ParentAvailability({
      parent: { baseUrl: BASE_URL, token: TOKEN },
      fetch: fetchImpl,
      now: () => clock,
    });
    expect(await client.getForRouting()).toEqual({
      claude: true,
      codex: false,
    });
    clock = 30001;
    failed = true;
    expect(await client.get()).toEqual({ claude: false, codex: false });
    expect(await client.getForRouting()).toEqual({
      claude: true,
      codex: false,
    });
    failed = false;
    clock = 31002;
    expect(await client.get()).toEqual({ claude: true, codex: false });
  });

  it("keeps configured cold routing on a transport failure without reporting a healthy parent", async () => {
    const client = availability({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await client.getForRouting()).toEqual({ claude: true, codex: true });
    expect(await client.get()).toEqual({ claude: false, codex: false });
  });

  it("does not resurrect a withdrawn route after a later transport failure", async () => {
    let clock = 0;
    let status = 200;
    const client = availability({
      fetchImpl: async () => {
        if (status === 0) throw new Error("ECONNRESET");
        return Response.json({ claude: true, codex: true }, { status });
      },
      now: () => clock,
    });
    expect((await client.getForRouting()).claude).toBe(true);
    clock = 1001;
    status = 401;
    expect((await client.getForRouting()).claude).toBe(false);
    clock = 2002;
    status = 0;
    expect((await client.getForRouting()).claude).toBe(false);
  });

  it.each([404, 408, 429, 500, 503])(
    "keeps cold routing on transient HTTP %s and retries promptly",
    async (status) => {
      let clock = 0;
      const client = new ParentAvailability({
        parent: { baseUrl: BASE_URL, token: TOKEN },
        now: () => clock,
        fetch: async () =>
          clock === 0
            ? new Response(null, { status })
            : Response.json({ claude: false, codex: true }),
      });
      expect(await client.getObserved()).toBeNull();
      expect(await client.getForRouting()).toEqual({
        claude: true,
        codex: true,
      });
      clock = 1001;
      expect(await client.getForRouting()).toEqual({
        claude: false,
        codex: true,
      });
    },
  );
});
