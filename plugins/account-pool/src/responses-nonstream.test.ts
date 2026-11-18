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
    const res = await handleResponses(post({ model: "m", stream: false }), async (req) => {
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
    const res = await handleResponses(post({ model: "m", stream: true }), async () => upstream);
    expect(res).toBe(upstream);
  });

  it("returns 502 when the stream fails", async () => {
    const res = await handleResponses(post({ stream: false }), async () =>
      sse([{ type: "response.failed", response: { error: { code: "x" } } }]),
    );
    expect(res.status).toBe(502);
  });

  it("returns upstream errors unchanged", async () => {
    const res = await handleResponses(post({ stream: false }), async () => new Response("no", { status: 429 }));
    expect(res.status).toBe(429);
  });
});
