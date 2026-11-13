import { expect, it } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
it("retains the exact strict expectation for descriptor and host while legacy bytes stay unchanged", async () => {
  const bodies: unknown[] = [];
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://bb.test",
      runtime: "node",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            baseUrl: "/lease",
            expiresAtMs: 1,
            policy: "artifact-v1",
            expectedSource: { hostId: "h", canonicalReadRoot: "/A" },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    }),
  });
  const expectedSource = { hostId: "h", canonicalReadRoot: "/A" };
  const requests = [
    { rootPath: "/legacy", hostId: "h" },
    {
      rootPath: "/brain",
      hostId: "h",
      policy: "artifact-v1" as const,
      expectedSource,
    },
    {
      target: {
        kind: "thread-storage" as const,
        threadId: "thr_a",
        root: "nested",
      },
      policy: "artifact-v1" as const,
      expectedSource,
    },
  ];
  for (const request of requests) {
    const response = await sdk.files.createPreview(request);
    expect(response.expectedSource).toEqual(expectedSource);
  }
  expect(bodies).toEqual(requests);
});
