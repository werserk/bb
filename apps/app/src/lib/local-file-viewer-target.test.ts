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
  it("opens workspace files alone", () =>
    expect(resolveHomeThread(workspace)).toBeNull());
  it.each([
    null,
    {},
    { ...storage, threadId: "" },
    { ...storage, relativePath: "../secret" },
    { ...storage, relativePath: "C:\\Users\\x.md" },
    { ...storage, lineRange: { startLineNumber: 5, endLineNumber: 2 } },
  ])("rejects malformed history params %j", (value) => {
    expect(parseLocalFileViewerTarget(value)).toBeNull();
    expect(resolveHomeThread(value)).toBeNull();
  });
});
