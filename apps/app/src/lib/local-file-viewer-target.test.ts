import { describe, expect, it } from "vitest";
import {
  parseLocalFileViewerTarget,
  resolveHomeThread,
} from "./local-file-viewer-target";

const storage = {
  kind: "thread-storage",
  threadId: "thr_abcd234567",
  path: "/storage/report.pdf",
  relativePath: "report.pdf",
  lineRange: null,
};
const workspace = {
  kind: "workspace",
  environmentId: "env_1",
  path: "/repo/report.md",
  relativePath: "report.md",
  lineRange: null,
};

describe("resolveHomeThread", () => {
  it("uses the storage thread", () =>
    expect(resolveHomeThread(storage)).toBe("thr_abcd234567"));
  it("does not guess from an unknown workspace list", () =>
    expect(resolveHomeThread(workspace)).toBeNull());
  it("accepts a complete unique active workspace membership", () => {
    expect(
      resolveHomeThread(workspace, {
        complete: true,
        threads: [
          { id: "thr_abcd234567", environmentId: "env_1", archived: false },
        ],
      }),
    ).toBe("thr_abcd234567");
  });
  it("rejects shared and incomplete membership", () => {
    const threads = ["thr_abcd234567", "thr_bcde234567"].map((id) => ({
      id,
      environmentId: "env_1",
      archived: false,
    }));
    expect(
      resolveHomeThread(workspace, { complete: true, threads }),
    ).toBeNull();
    expect(
      resolveHomeThread(workspace, {
        complete: false,
        threads: threads.slice(0, 1),
      }),
    ).toBeNull();
  });
  it("ignores archived threads and other environments", () => {
    expect(
      resolveHomeThread(workspace, {
        complete: true,
        threads: [
          { id: "thr_cdef234567", environmentId: "env_1", archived: true },
        ],
      }),
    ).toBeNull();
  });
  it.each([
    null,
    {},
    { ...storage, threadId: "" },
    { ...storage, relativePath: "../secret" },
    { ...storage, lineRange: { startLineNumber: 5, endLineNumber: 2 } },
  ])("rejects malformed history params %j", (value) => {
    expect(parseLocalFileViewerTarget(value)).toBeNull();
    expect(resolveHomeThread(value)).toBeNull();
  });
});
