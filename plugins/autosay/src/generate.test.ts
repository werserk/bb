import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { completionUrl, generate, type GeneratorConfig } from "./generate.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return `http://127.0.0.1:${address.port}/v1`;
}
function config(baseUrl: string): GeneratorConfig {
  return {
    baseUrl,
    model: "fixture",
    apiKey: "fixture-key",
    instructions: "Predict",
    timeoutMs: 2000,
    outputTokenLimit: 256,
  };
}
describe("generator boundaries", () => {
  it("uses one isolated no-tools request and accepts a bounded JSON suggestion", async () => {
    let body = "";
    let auth = "";
    const url = await fixture((req, res) => {
      auth = req.headers.authorization ?? "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () =>
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    kind: "suggestion",
                    text: "Run the tests.",
                  }),
                },
              },
            ],
          }),
        ),
      );
    });
    expect(
      await generate(config(url), "context", new AbortController().signal),
    ).toEqual({ kind: "suggestion", text: "Run the tests." });
    expect(auth).toBe("Bearer fixture-key");
    expect(JSON.parse(body)).toEqual({
      model: "fixture",
      messages: [
        { role: "system", content: "Predict" },
        { role: "user", content: "context" },
      ],
      max_tokens: 256,
      stream: false,
    });
  });
  it("does not retry errors or include backend content in the error", async () => {
    let calls = 0;
    const url = await fixture((_req, res) => {
      calls++;
      res.writeHead(429);
      res.end("private backend detail");
    });
    await expect(
      generate(config(url), "context", new AbortController().signal),
    ).rejects.toThrow(/^Generator HTTP 429$/);
    expect(calls).toBe(1);
  });
  it.each([
    "not JSON",
    JSON.stringify({
      choices: [
        { finish_reason: "length", message: { content: '{"kind":"none"}' } },
      ],
    }),
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              kind: "suggestion",
              text: "x".repeat(601),
            }),
          },
        },
      ],
    }),
  ])("rejects invalid or truncated output", async (body) => {
    const url = await fixture((_req, res) => res.end(body));
    await expect(
      generate(config(url), "context", new AbortController().signal),
    ).rejects.toThrow();
  });
  it("bounds response bytes", async () => {
    const url = await fixture((_req, res) => res.end("x".repeat(65537)));
    await expect(
      generate(config(url), "context", new AbortController().signal),
    ).rejects.toThrow("too large");
  });
  it("aborts a hanging response", async () => {
    const url = await fixture(() => undefined);
    await expect(
      generate(
        { ...config(url), timeoutMs: 30 },
        "context",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it.each([
    "http://example.com/v1",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?key=secret",
  ])("rejects unsafe configured URLs", (url) => {
    expect(() => completionUrl(url)).toThrow();
  });
});
