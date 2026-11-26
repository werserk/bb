import { describe, expect, it } from "vitest";
import { handleResponses } from "./responses-nonstream.js";

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const post = (body: unknown) =>
  new Request("http://pool/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(body),
  });

describe("handleResponses", () => {
  it("streams upstream for stream:false and returns the final response as JSON", async () => {
    let seen: Record<string, unknown> = {};
    const res = await handleResponses(post({ model: "m", input: [], stream: false }), async (req) => {
      seen = (await req.json()) as Record<string, unknown>;
      expect(req.headers.get("authorization")).toBe("Bearer t");
      return sse([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { id: "r1", output: [] } },
      ]);
    });
    expect(seen.stream).toBe(true);
    expect(await res.json()).toEqual({ id: "r1", output: [] });
  });

  it("passes streaming requests through untouched", async () => {
    const upstream = sse([{ type: "response.completed", response: {} }]);
    const res = await handleResponses(post({ model: "m", input: [], stream: true }), async () => upstream);
    expect(res).toBe(upstream);
  });

  it("returns 502 when the stream fails", async () => {
    const res = await handleResponses(post({ model: "m", input: [], stream: false }), async () =>
      sse([{ type: "response.failed", response: { error: { code: "x" } } }]),
    );
    expect(res.status).toBe(502);
  });

  it("returns upstream errors unchanged", async () => {
    const res = await handleResponses(post({ model: "m", input: [], stream: false }), async () => new Response("no", { status: 429 }));
    expect(res.status).toBe(429);
  });
});

describe("handleResponses request shapes", () => {
  it("treats an absent stream field as non-streaming, as the OpenAI SDK sends it", async () => {
    let seen: Record<string, unknown> = {};
    const res = await handleResponses(post({ model: "m", input: [] }), async (req) => {
      seen = (await req.json()) as Record<string, unknown>;
      return sse([{ type: "response.completed", response: { id: "r2" } }]);
    });
    expect(seen.stream).toBe(true);
    expect(await res.json()).toEqual({ id: "r2" });
  });

  it("leaves bodies that are not Responses requests untouched", async () => {
    let seen = "";
    await handleResponses(post({ prompt_cache_key: "k" }), async (req) => {
      seen = await req.text();
      return new Response("{}");
    });
    expect(JSON.parse(seen)).toEqual({ prompt_cache_key: "k" });
  });
});

describe("handleResponses fidelity", () => {
  it("forwards compressed bodies byte for byte", async () => {
    const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0x00, 0x80]);
    let seen = new Uint8Array();
    await handleResponses(
      new Request("http://pool/v1/responses", {
        method: "POST",
        headers: { "content-encoding": "zstd" },
        body: bytes,
      }),
      async (req) => {
        seen = new Uint8Array(await req.arrayBuffer());
        return new Response("{}");
      },
    );
    expect(Array.from(seen)).toEqual(Array.from(bytes));
  });

  it("maps a rate-limit failure in the stream to 429", async () => {
    const res = await handleResponses(post({ model: "m", input: [] }), async () =>
      sse([{ type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } }]),
    );
    expect(res.status).toBe(429);
  });

  it("treats completed without a response as a failure", async () => {
    const res = await handleResponses(post({ model: "m", input: [] }), async () =>
      sse([{ type: "response.completed" }]),
    );
    expect(res.status).toBe(502);
  });
});

describe("handleResponses upstream content types", () => {
  it("collects an SSE body labelled text/plain", async () => {
    const res = await handleResponses(post({ model: "m", input: [] }), async () =>
      new Response(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r3" } })}\n\n`,
        { headers: { "content-type": "text/plain; charset=UTF-8" } },
      ),
    );
    expect(await res.json()).toEqual({ id: "r3" });
  });

  it("passes a JSON upstream reply through", async () => {
    const upstream = Response.json({ id: "plain" });
    const res = await handleResponses(post({ model: "m", input: [] }), async () => upstream);
    expect(res).toBe(upstream);
  });
});
