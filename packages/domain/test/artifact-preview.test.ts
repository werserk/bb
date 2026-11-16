import { expect, it } from "vitest";
import {
  isArtifactCanonicalRoot,
  isArtifactRelativePath,
} from "../src/artifact-preview.js";
it("separates exact canonical identities from portable structural paths", () => {
  for (const root of [
    "/",
    "/var/storage",
    "C:\\",
    "c:/Storage",
    "\\\\server\\share",
    "\\\\server\\share\\Folder",
  ])
    expect(isArtifactCanonicalRoot(root), root).toBe(true);
  for (const root of [
    "relative",
    "//ambiguous",
    "/a/../b",
    "C:a",
    "/a/./b",
    "/bad\u0000root",
  ])
    expect(isArtifactCanonicalRoot(root), root).toBe(false);
  for (const relative of ["Mixed/Case.md", "a%2fb.md", "a b.md"])
    expect(isArtifactRelativePath(relative)).toBe(true);
  for (const relative of [
    "",
    "/a",
    "a/",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "C:secret",
    "\\\\server\\share",
    "\u0000a",
    "\ud800",
  ])
    expect(isArtifactRelativePath(relative), relative).toBe(false);
});
