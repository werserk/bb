import { describe, expect, it } from "vitest";
import { HUNK_MAX_LINES, unifiedHunk } from "./hunk.js";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("unifiedHunk", () => {
  it("shows one changed line with three lines of context and correct ranges", () => {
    const before = numbered(10);
    const after = before.replace("line 5\n", "line five\n");
    expect(unifiedHunk("f.txt", before, after)).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -2,7 +2,7 @@",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        "+line five",
        " line 6",
        " line 7",
        " line 8",
      ].join("\n"),
    );
  });

  it("covers an insertion at the end and a pure deletion", () => {
    expect(unifiedHunk("f", "a\n", "a\nb\n")).toBe("--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+b");
    expect(unifiedHunk("f", "a\nb\nc\n", "a\nc\n")).toBe("--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n-b\n c");
  });

  it("names unchanged content and a final-newline-only change", () => {
    expect(unifiedHunk("f", "a\n", "a\n")).toBe("(no change)");
    expect(unifiedHunk("f", "a", "a\n")).toBe("(only the final newline changed)");
  });

  it("keeps a large change short", () => {
    const hunk = unifiedHunk("f", numbered(200), "");
    const lines = hunk.split("\n");
    expect(lines).toHaveLength(3 + HUNK_MAX_LINES + 1);
    expect(lines.at(-1)).toBe(`… ${200 - HUNK_MAX_LINES} more diff lines`);
    expect(lines[2]).toBe("@@ -1,200 +0,0 @@");
  });
});
