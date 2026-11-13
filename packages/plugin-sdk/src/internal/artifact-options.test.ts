import { expect, it } from "vitest";
import { normalizeExperimentalFileOpenOptions as normalize } from "./file-navigation-validation.js";
it.each([
  [{ kind: "workspace", environmentId: "e", path: "a.md" }, ""],
  [{ kind: "thread-storage", threadId: "t", path: "nested/a.md" }, "nested"],
  [{ kind: "host", hostId: "h", path: "/brain/a.md" }, "/brain"],
  [{ kind: "host", hostId: "h", path: "C:\\brain\\a.md" }, "C:\\brain"],
  [
    { kind: "host", hostId: "h", path: "\\\\server\\share\\a.md" },
    "\\\\server\\share",
  ],
])("retains scope for %j", (target, readRoot) => {
  const intent = {
    target,
    location: null,
    experimental_artifact: { version: 1, readRoot },
  };
  expect(normalize(intent)).toEqual(intent);
});
it.each(["../brain", "/absolute", "C:\\brain", "nested/../x"])(
  "refuses relative root %s",
  (readRoot) => {
    expect(
      normalize({
        target: { kind: "thread-storage", threadId: "t", path: "a.md" },
        location: null,
        experimental_artifact: { version: 1, readRoot },
      }),
    ).toBeNull();
  },
);
it("refuses unknown scope keys, versions, refs and locations", () => {
  const intent = {
    target: { kind: "workspace", environmentId: "e", path: "a.md" },
    location: null,
    experimental_artifact: { version: 1, readRoot: "" },
  };
  expect(
    normalize({
      ...intent,
      experimental_artifact: { ...intent.experimental_artifact, foo: true },
    }),
  ).toBeNull();
  expect(
    normalize({
      ...intent,
      experimental_artifact: { version: 2, readRoot: "" },
    }),
  ).toBeNull();
  expect(
    normalize({
      ...intent,
      target: { ...intent.target, experimental_ref: "HEAD" },
    }),
  ).toBeNull();
  expect(
    normalize({ ...intent, location: { kind: "line", line: 1, column: null } }),
  ).toBeNull();
});
