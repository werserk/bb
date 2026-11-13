import { expect, it, vi, afterEach } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  sdk: { files: { createPreview: mocks.create } },
}));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: mocks.fetch }));
import { readScopedArtifact } from "./ScopedArtifactBody";
afterEach(() => vi.resetAllMocks());
const target = {
  kind: "thread-storage" as const,
  threadId: "thr_abcd234567",
  path: "nested/report.md",
  relativePath: "nested/report.md",
  lineRange: null,
  experimental_artifact: { version: 1 as const, readRoot: "nested" },
};
it("never fetches a lease without policy acknowledgement", async () => {
  mocks.create.mockResolvedValue({
    baseUrl: "/unscoped",
    expiresAtMs: Date.now() + 60000,
  });
  await expect(
    readScopedArtifact(target, new AbortController().signal),
  ).rejects.toThrow("unavailable");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("reads scoped Markdown only from acknowledged bytes and renews the same descriptor", async () => {
  mocks.create.mockResolvedValue({
    baseUrl: "/api/v1/file-previews/lease",
    expiresAtMs: Date.now() + 60000,
    policy: "artifact-v1",
  });
  mocks.fetch.mockResolvedValue(new Response("# scoped"));
  const result = await readScopedArtifact(target, new AbortController().signal);
  expect(result.text).toBe("# scoped");
  expect(mocks.fetch.mock.calls[0]![0]).toBe(
    "/api/v1/file-previews/lease/report.md",
  );
  mocks.fetch.mockResolvedValue(new Response("# renewed"));
  await readScopedArtifact(target, new AbortController().signal);
  for (const [request] of mocks.create.mock.calls)
    expect(request).toMatchObject({
      target: {
        kind: "thread-storage",
        threadId: target.threadId,
        root: "nested",
      },
      policy: "artifact-v1",
    });
  expect(
    mocks.fetch.mock.calls.every(([url]) =>
      url.startsWith("/api/v1/file-previews/"),
    ),
  ).toBe(true);
});
it("does not retry an old server rejection without policy", async () => {
  mocks.create.mockRejectedValue(new Error("400"));
  await expect(
    readScopedArtifact(target, new AbortController().signal),
  ).rejects.toThrow("400");
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
