import { expect, it } from "vitest";
import { isOrdinaryArtifact } from "./artifact-activation";
it.each([
  "a.HTML",
  "a.htm",
  "a.markdown",
  "a.md",
  "a.pdf",
  "a.png",
  "a.jpeg",
  "a.gif",
  "a.webp",
  "a.svg",
])("classifies %s", (path) => {
  expect(
    isOrdinaryArtifact({
      target: { kind: "workspace", environmentId: "e", path },
      location: null,
    }),
  ).toBe(true);
  expect(
    isOrdinaryArtifact({
      target: {
        kind: "workspace",
        environmentId: "e",
        path,
        experimental_ref: "HEAD",
      },
      location: null,
    }),
  ).toBe(false);
  expect(
    isOrdinaryArtifact({
      target: { kind: "workspace", environmentId: "e", path },
      location: { kind: "line", line: 2, column: null },
    }),
  ).toBe(false);
});
it.each(["a", "a.txt", "a.json", "a.csv", "a.log", "a.py"])(
  "preserves %s",
  (path) => {
    expect(
      isOrdinaryArtifact({
        target: { kind: "host", hostId: "h", path },
        location: null,
      }),
    ).toBe(false);
  },
);
