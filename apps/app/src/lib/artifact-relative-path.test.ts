import { expect, it } from "vitest";
import { requireArtifactRelativePath } from "./artifact-admission";
it.each([
  ["/", "/Mixed/Report.md", "Mixed/Report.md"],
  ["C:\\", "c:\\Mixed\\Report.md", "Mixed/Report.md"],
  ["C:\\Root", "c:/root/Mixed/Report.md", "Mixed/Report.md"],
  [
    "\\\\Server\\Share",
    "\\\\server\\share\\Mixed\\Report.md",
    "Mixed/Report.md",
  ],
  ["/root", "/root/a%2fb.md", "a%2fb.md"],
])(
  "keeps raw relative case without URL decoding: %s",
  (readRoot, path, expected) => {
    expect(
      requireArtifactRelativePath(
        { kind: "host", hostId: "h", path },
        readRoot,
      ),
    ).toBe(expected);
  },
);
it.each([
  "/root/../root/a.md",
  "/root/./a.md",
  "/rooted/a.md",
  "/Root/a.md",
  "/root/",
  "C:root/a.md",
])("refuses collapsing or outside path %s", (path) => {
  expect(() =>
    requireArtifactRelativePath({ kind: "host", hostId: "h", path }, "/root"),
  ).toThrow();
});
