import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeTransport } from "../src/node.js";
import {
  BbRequestTimeoutError,
  createRequestTimeoutFetch,
} from "../src/response.js";

const nativeFetch = globalThis.fetch;
const reset = (code = "ECONNRESET") =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket closed"), { code }),
  });

afterEach(() => vi.restoreAllMocks());

async function withServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => Promise<void>,
) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("native GET reset retry", () => {
  it("recovers once when a real server closes a reused socket", async () => {
    const sockets = new Set<IncomingMessage["socket"]>();
    let attempts = 0;
    let reused = false;
    await withServer(
      (request, response) => {
        if (request.url === "/warm") {
          sockets.add(request.socket);
          response.end("warm");
        } else {
          expect(request.method).toBe("GET");
          expect(request.headers["x-request"]).toBe("kept");
          if (++attempts === 1) {
            reused = sockets.has(request.socket);
            request.socket.destroy();
          } else {
            response.setHeader("x-result", "retried");
            response.end("ok");
          }
        }
      },
      async (url) => {
        const transport = createNodeTransport({ baseUrl: url });
        for (let i = 0; i < 4; i++) {
          await (await transport.fetch(`${url}/warm`)).text();
          await delay(0);
        }
        const response = await transport.fetch(
          new Request(`${url}/read`, {
            headers: { "x-request": "kept" },
          }),
        );
        expect(response.headers.get("x-result")).toBe("retried");
        expect(await response.text()).toBe("ok");
      },
    );
    expect(reused).toBe(true);
    expect(attempts).toBe(2);
  });

  it("terminates after a persistent real socket reset", async () => {
    let attempts = 0;
    await withServer(
      (request) => {
        attempts++;
        request.socket.destroy();
      },
      async (url) => {
        await expect(
          createRequestTimeoutFetch({ timeoutMs: 1000 })(url),
        ).rejects.toThrow();
      },
    );
    expect(attempts).toBe(2);
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET"])(
    "retries only the identified %s cause once",
    async (code) => {
      const failure = reset(code);
      const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
      await expect(
        createRequestTimeoutFetch({ timeoutMs: 1000 })("http://server"),
      ).rejects.toBe(failure);
      expect(mock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ABORT_ERR",
    "UND_ERR_CONNECT_TIMEOUT",
  ])("does not retry %s", async (code) => {
    const failure = reset(code);
    const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 1000 })("http://server"),
    ).rejects.toBe(failure);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError("network error"),
    new DOMException("aborted", "AbortError"),
    Object.assign(new TypeError("reset"), { code: "ECONNRESET" }),
  ])("does not guess from a generic error", async (failure) => {
    const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 1000 })("http://server"),
    ).rejects.toBe(failure);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 429, 500, 503])(
    "does not retry HTTP %s",
    async (status) => {
      const mock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status }));
      expect(
        (await createRequestTimeoutFetch({ timeoutMs: 1000 })("http://server"))
          .status,
      ).toBe(status);
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "never replays %s from Request or init",
    async (method) => {
      const failure = reset();
      const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
      const fetch = createRequestTimeoutFetch({ timeoutMs: 1000 });
      await expect(
        fetch(new Request("http://server", { method })),
      ).rejects.toBe(failure);
      expect(mock).toHaveBeenCalledTimes(1);
      mock.mockClear();
      await expect(
        fetch(new Request("http://server"), { method }),
      ).rejects.toBe(failure);
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves Request headers and GET override across retry", async () => {
    const request = new Request("http://server", {
      method: "HEAD",
      headers: { "x-request": "kept" },
    });
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(new Response("ok"));
    await createRequestTimeoutFetch({ timeoutMs: 1000 })(request, {
      method: "GET",
      headers: { "x-override": "kept" },
    });
    expect(mock).toHaveBeenCalledTimes(2);
    for (const [input, init] of mock.mock.calls) {
      expect(input).toBe(request);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-override")).toBe("kept");
    }
    expect(request.headers.get("x-request")).toBe("kept");
  });

  it("honors Request cancellation during the retry", async () => {
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(reset())
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
            caller.abort(reason);
          }),
      );
    const request = new Request("http://server", { signal: caller.signal });
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 1000 })(request),
    ).rejects.toBe(reason);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a reset after caller abort", async () => {
    const caller = new AbortController();
    const failure = reset();
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      caller.abort();
      throw failure;
    });
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 1000 })("http://server", {
        signal: caller.signal,
      }),
    ).rejects.toBe(failure);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("uses one total timeout including the first attempt and retried body", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await delay(60);
        throw reset();
      })
      .mockImplementationOnce(
        async (_input, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
      );
    const response = await createRequestTimeoutFetch({ timeoutMs: 120 })(
      "http://server",
    );
    await expect(response.text()).rejects.toBeInstanceOf(BbRequestTimeoutError);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(120);
    expect(mock.mock.calls[0]?.[1]?.signal).toBe(
      mock.mock.calls[1]?.[1]?.signal,
    );
  });

  it("keeps one deadline while the second attempt waits for headers", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await delay(60);
        throw reset();
      })
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 120 })("http://server"),
    ).rejects.toBeInstanceOf(BbRequestTimeoutError);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(120);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]?.[1]?.signal).toBe(
      mock.mock.calls[1]?.[1]?.signal,
    );
  });

  it("honors an already aborted Request without sending to the server", async () => {
    let attempts = 0;
    const caller = new AbortController();
    const reason = new Error("cancelled before fetch");
    caller.abort(reason);
    await withServer(
      (_request, response) => {
        attempts++;
        response.end("unexpected");
      },
      async (url) => {
        await expect(
          createRequestTimeoutFetch({ timeoutMs: 1000 })(
            new Request(url, { signal: caller.signal }),
          ),
        ).rejects.toBe(reason);
      },
    );
    expect(attempts).toBe(0);
  });

  it("leaves explicit init signal in charge over Request signal", async () => {
    const ignored = new AbortController();
    ignored.abort();
    const caller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Response("ok");
    });
    await expect(
      createRequestTimeoutFetch({ timeoutMs: 1000 })(
        new Request("http://server", { signal: ignored.signal }),
        { signal: caller.signal },
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it("does not replay a response stream that resets after headers", async () => {
    let attempts = 0;
    await withServer(
      (request, response) => {
        attempts++;
        response.writeHead(200);
        response.write("first");
        setTimeout(() => request.socket.destroy(), 30);
      },
      async (url) => {
        const response = await createRequestTimeoutFetch({ timeoutMs: 1000 })(
          url,
        );
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(
          "first",
        );
        await expect(reader.read()).rejects.toThrow();
      },
    );
    expect(attempts).toBe(1);
    expect(globalThis.fetch).toBe(nativeFetch);
  });
});
