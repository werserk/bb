import { expect, it, vi, afterEach, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  sdk: { files: { createPreview: mocks.create } },
}));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: mocks.fetch }));
import {
  createArtifactAdmission,
  ARTIFACT_ADMISSION_TIMEOUT_MS,
} from "@/lib/artifact-admission";
import { readScopedArtifact } from "./ScopedArtifactBody";
let custody: ReturnType<typeof createArtifactAdmission>;
let revalidate: ReturnType<
  typeof vi.fn<
    (request: {
      target: import("@get-bb/plugin-sdk").ExperimentalLiveFileTarget;
      readRoot: string;
      relativePath: string;
      signal: AbortSignal;
    }) => Promise<boolean>
  >
>;
let caller: AbortController;
beforeEach(() => {
  caller = new AbortController();
  revalidate = vi.fn(async () => true);
  custody = createArtifactAdmission({
    target: {
      kind: "thread-storage",
      threadId: target.threadId,
      path: target.relativePath,
    },
    location: null,
    experimental_artifact: {
      ...target.experimental_artifact,
      physicalSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
      revalidate,
      lifetime: caller.signal,
    },
  });
  custody.bind("modal-test");
});
afterEach(() => {
  custody.dispose();
  vi.resetAllMocks();
  vi.useRealTimers();
});
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
    readScopedArtifact(target, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("unavailable");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("reads scoped Markdown only from acknowledged bytes and renews the same descriptor", async () => {
  mocks.create.mockResolvedValue({
    baseUrl: "/api/v1/file-previews/lease",
    expiresAtMs: Date.now() + 60000,
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
  });
  mocks.fetch.mockResolvedValue(new Response("# scoped"));
  const result = await readScopedArtifact(
    target,
    new AbortController().signal,
    "modal-test",
  );
  expect(result.text).toBe("# scoped");
  expect(revalidate).toHaveBeenCalledWith({
    target: {
      kind: "thread-storage",
      threadId: target.threadId,
      path: "nested/report.md",
    },
    readRoot: "nested",
    relativePath: "report.md",
    signal: expect.any(AbortSignal),
  });
  expect(mocks.fetch.mock.calls[0]![0]).toBe(
    "/api/v1/file-previews/lease/report.md",
  );
  mocks.fetch.mockResolvedValue(new Response("# renewed"));
  await readScopedArtifact(target, new AbortController().signal, "modal-test");
  expect(revalidate).toHaveBeenCalledTimes(2);
  for (const [request] of mocks.create.mock.calls)
    expect(request).toMatchObject({
      target: {
        kind: "thread-storage",
        threadId: target.threadId,
        root: "nested",
      },
      policy: "artifact-v1",
      expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
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
    readScopedArtifact(target, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("400");
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([false, undefined, {}, "true", 1])(
  "refuses non-literal admission %j without a lease or bytes",
  async (value) => {
    revalidate.mockResolvedValue(value as boolean);
    await expect(
      readScopedArtifact(target, new AbortController().signal, "modal-test"),
    ).rejects.toThrow("refused");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("refuses a callback exception before any request", async () => {
  revalidate.mockRejectedValue(new Error("RPC unavailable"));
  await expect(
    readScopedArtifact(target, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("RPC unavailable");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("bounds an RPC ignoring its signal with the exported core deadline and ignores its late true", async () => {
  vi.useFakeTimers();
  let complete!: (value: boolean) => void;
  revalidate.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const read = readScopedArtifact(
    target,
    new AbortController().signal,
    "modal-test",
  );
  const rejected = expect(read).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(ARTIFACT_ADMISSION_TIMEOUT_MS - 1);
  expect(mocks.create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(revalidate.mock.calls[0]![0].signal.aborted).toBe(true);
  complete(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["attempt", "caller", "dispose"])(
  "cancels %s while admission ignores cancellation",
  async (kind) => {
    let complete!: (value: boolean) => void;
    revalidate.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const attempt = new AbortController();
    const read = readScopedArtifact(target, attempt.signal, "modal-test");
    const rejected = expect(read).rejects.toThrow("cancelled");
    await Promise.resolve();
    if (kind === "attempt") attempt.abort();
    else if (kind === "caller") caller.abort();
    else custody.dispose();
    await rejected;
    complete(true);
    await Promise.resolve();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("fences a replaced generation even if the first admission completes late", async () => {
  let complete!: (value: boolean) => void;
  revalidate
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(true);
  const first = readScopedArtifact(
    target,
    new AbortController().signal,
    "modal-test",
  );
  const rejected = expect(first).rejects.toThrow();
  await Promise.resolve();
  mocks.create.mockResolvedValue({
    baseUrl: "/api/v1/file-previews/new",
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
  });
  mocks.fetch.mockResolvedValue(new Response("# current"));
  expect(
    (
      await readScopedArtifact(
        target,
        new AbortController().signal,
        "modal-test",
      )
    ).text,
  ).toBe("# current");
  await rejected;
  complete(true);
  await Promise.resolve();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("refuses altered target/root or a dead/missing record before invoking the callback", async () => {
  for (const [value, token] of [
    [{ ...target, relativePath: "nested/other.md" }, "modal-test"],
    [
      {
        ...target,
        experimental_artifact: { version: 1 as const, readRoot: "" },
      },
      "modal-test",
    ],
    [target, "missing"],
  ] as const) {
    await expect(
      readScopedArtifact(value, new AbortController().signal, token),
    ).rejects.toThrow("no longer available");
  }
  custody.dispose();
  await expect(
    readScopedArtifact(target, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("no longer available");
  expect(revalidate).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("does not fetch bytes after a lease response arrives for a disposed record", async () => {
  let complete!: (value: unknown) => void;
  mocks.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const read = readScopedArtifact(
    target,
    new AbortController().signal,
    "modal-test",
  );
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  custody.dispose();
  complete({
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
    baseUrl: "/api/v1/file-previews/late",
  });
  await rejected;
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("uses the admitted host candidate as the byte path even if display history differs", async () => {
  custody.dispose();
  const host = {
    kind: "host" as const,
    hostId: "primary",
    path: "/brain/report.md",
    relativePath: "/brain/other.md",
    lineRange: null,
    experimental_artifact: { version: 1 as const, readRoot: "/brain" },
  };
  custody = createArtifactAdmission({
    target: { kind: "host", hostId: host.hostId, path: host.path },
    location: null,
    experimental_artifact: {
      ...host.experimental_artifact,
      physicalSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
      revalidate,
      lifetime: caller.signal,
    },
  });
  custody.bind("modal-test");
  mocks.create.mockResolvedValue({
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
    baseUrl: "/api/v1/file-previews/host",
  });
  mocks.fetch.mockResolvedValue(new Response("# admitted"));
  await readScopedArtifact(host, new AbortController().signal, "modal-test");
  expect(mocks.fetch.mock.calls[0]![0]).toBe(
    "/api/v1/file-previews/host/report.md",
  );
  expect(revalidate.mock.calls[0]![0].target).toEqual({
    kind: "host",
    hostId: "primary",
    path: "/brain/report.md",
  });
});

it.each([
  { hostId: "other", canonicalReadRoot: "/source/A" },
  { hostId: "primary", canonicalReadRoot: "/source/B" },
  undefined,
])(
  "refuses mismatched physical acknowledgement %j before bytes",
  async (expectedSource) => {
    mocks.create.mockResolvedValue({
      policy: "artifact-v1",
      expectedSource,
      baseUrl: "/lease",
    });
    await expect(
      readScopedArtifact(target, new AbortController().signal, "modal-test"),
    ).rejects.toThrow("unavailable");
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("retains the physical expectation and refuses controlled redirects", async () => {
  mocks.create.mockResolvedValue({
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
    baseUrl: "/lease",
  });
  mocks.fetch.mockRejectedValue(new TypeError("redirect refused"));
  await expect(
    readScopedArtifact(target, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("redirect refused");
  expect(mocks.create.mock.calls[0]![0].expectedSource).toEqual({
    hostId: "primary",
    canonicalReadRoot: "/source/A",
  });
  expect(mocks.fetch.mock.calls[0]![1]).toMatchObject({
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});
it("decodes UTF16 BOM bytes under the actual UTF8 header and checks the byte cap", async () => {
  custody.dispose();
  const html = {
    ...target,
    path: "nested/report.html",
    relativePath: "nested/report.html",
  };
  custody = createArtifactAdmission({
    target: {
      kind: "thread-storage",
      threadId: html.threadId,
      path: html.relativePath,
    },
    location: null,
    experimental_artifact: {
      ...html.experimental_artifact,
      physicalSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
      revalidate,
      lifetime: caller.signal,
    },
  });
  custody.bind("modal-test");
  mocks.create.mockResolvedValue({
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
    baseUrl: "/lease",
  });
  const content = "<h1>Привет 世界</h1>";
  const bytes = new Uint8Array(2 + content.length * 2);
  bytes.set([255, 254]);
  for (let i = 0; i < content.length; i++) {
    bytes[2 + i * 2] = content.charCodeAt(i) & 255;
    bytes[3 + i * 2] = content.charCodeAt(i) >> 8;
  }
  mocks.fetch.mockResolvedValue(
    new Response(bytes, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  expect(
    (await readScopedArtifact(html, new AbortController().signal, "modal-test"))
      .text,
  ).toBe(content);
  mocks.fetch.mockResolvedValue(
    new Response(new Uint8Array(1_000_001), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  await expect(
    readScopedArtifact(html, new AbortController().signal, "modal-test"),
  ).rejects.toThrow("large");
});
it("discards a body completing after disposal even when arrayBuffer ignores cancellation", async () => {
  mocks.create.mockResolvedValue({
    policy: "artifact-v1",
    expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
    baseUrl: "/lease",
  });
  let complete!: (value: ArrayBuffer) => void;
  const response = new Response("unused");
  vi.spyOn(response, "arrayBuffer").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  mocks.fetch.mockResolvedValue(response);
  const read = readScopedArtifact(
    target,
    new AbortController().signal,
    "modal-test",
  );
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(response.arrayBuffer).toHaveBeenCalled());
  custody.dispose();
  complete(new TextEncoder().encode("late private text").buffer);
  await rejected;
});
