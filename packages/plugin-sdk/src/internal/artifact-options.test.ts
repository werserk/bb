import { expect, it, vi } from "vitest";
import {
  normalizeExperimentalFileOpenOptions as normalize,
  normalizeExperimentalArtifactScope,
} from "./file-navigation-validation.js";
it.each([
  [{ kind: "workspace", environmentId: "e", path: "a.md" }, ""],
  [{ kind: "thread-storage", threadId: "t", path: "nested/a.md" }, "nested"],
  [{ kind: "host", hostId: "h", path: "/brain/a.md" }, "/brain"],
  [{ kind: "host", hostId: "h", path: "/a.md" }, "/"],
  [{ kind: "host", hostId: "h", path: "c:/ROOT/Mixed.md" }, "C:\\root"],
  [
    { kind: "host", hostId: "h", path: "\\\\SERVER\\Share\\Mixed.md" },
    "\\\\server\\share",
  ],
  [{ kind: "host", hostId: "h", path: "C:\\brain\\a.md" }, "C:\\brain"],
  [
    { kind: "host", hostId: "h", path: "\\\\server\\share\\a.md" },
    "\\\\server\\share",
  ],
])("retains scope for %j", (target, readRoot) => {
  const intent = {
    target,
    location: null,
    experimental_artifact: {
      version: 1,
      readRoot,
      physicalSource: {
        hostId: "hostId" in target ? target.hostId : "h",
        canonicalReadRoot: "/original",
      },
      revalidate: async () => true,
      lifetime: new AbortController().signal,
    },
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
        experimental_artifact: {
          version: 1,
          readRoot,
          physicalSource: { hostId: "h", canonicalReadRoot: "/original" },
          revalidate: async () => true,
          lifetime: new AbortController().signal,
        },
      }),
    ).toBeNull();
  },
);
it("refuses unknown scope keys, versions, refs and locations", () => {
  const intent = {
    target: { kind: "workspace", environmentId: "e", path: "a.md" },
    location: null,
    experimental_artifact: {
      version: 1,
      readRoot: "",
      physicalSource: { hostId: "h", canonicalReadRoot: "/original" },
      revalidate: async () => true,
      lifetime: new AbortController().signal,
    },
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
      experimental_artifact: { ...intent.experimental_artifact, version: 2 },
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

it("retains callable/signal identity and keeps JSON parsing separate", () => {
  const revalidate = vi.fn(async () => true);
  const lifetime = new AbortController().signal;
  const target = {
    kind: "workspace" as const,
    environmentId: "e",
    path: "a.md",
  };
  const scope = { version: 1, readRoot: "" };
  const options = {
    target,
    location: null,
    experimental_artifact: {
      ...scope,
      physicalSource: { hostId: "h", canonicalReadRoot: "/original" },
      revalidate,
      lifetime,
    },
  };
  const value = normalize(options)!;
  expect(value.experimental_artifact?.revalidate).toBe(revalidate);
  expect(value.experimental_artifact?.lifetime).toBe(lifetime);
  expect(normalize({ ...options, experimental_artifact: scope })).toBeNull();
  expect(normalizeExperimentalArtifactScope(target, null, scope)).toEqual(
    scope,
  );
  expect(
    normalizeExperimentalArtifactScope(
      target,
      null,
      options.experimental_artifact,
    ),
  ).toBeNull();
});
it.each([
  { revalidate: null, lifetime: new AbortController().signal },
  { revalidate: true, lifetime: new AbortController().signal },
  { revalidate: async () => true, lifetime: {} },
  {
    revalidate: async () => true,
    lifetime: {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    },
  },
  { revalidate: async () => true, lifetime: AbortSignal.abort() },
])("refuses unusable imperative custody %#", (fields) => {
  expect(
    normalize({
      target: { kind: "workspace", environmentId: "e", path: "a.md" },
      location: null,
      experimental_artifact: { version: 1, readRoot: "", ...fields },
    }),
  ).toBeNull();
});

it("requires and copies exact physical custody without putting it into JSON scope", () => {
  const physicalSource = { hostId: "h", canonicalReadRoot: "/original" };
  const artifact = {
    version: 1,
    readRoot: "/brain",
    physicalSource,
    revalidate: async () => true,
    lifetime: new AbortController().signal,
  };
  const intent = {
    target: { kind: "host", hostId: "h", path: "/brain/a.md" },
    location: null,
    experimental_artifact: artifact,
  };
  const normalized = normalize(intent)!;
  expect(normalized.experimental_artifact?.physicalSource).toEqual(
    physicalSource,
  );
  physicalSource.canonicalReadRoot = "/replacement";
  expect(
    normalized.experimental_artifact?.physicalSource.canonicalReadRoot,
  ).toBe("/original");
  for (const source of [
    undefined,
    null,
    {},
    { hostId: "h" },
    { hostId: "other", canonicalReadRoot: "/original" },
    { hostId: "h", canonicalReadRoot: "relative" },
    { hostId: "h", canonicalReadRoot: "/original/../replacement" },
    { hostId: "h", canonicalReadRoot: "/original", extra: true },
  ]) {
    expect(
      normalize({
        ...intent,
        experimental_artifact: { ...artifact, physicalSource: source },
      }),
    ).toBeNull();
  }
  expect(
    normalizeExperimentalArtifactScope(
      { kind: "host", hostId: "h", path: "/brain/a.md" },
      null,
      { version: 1, readRoot: "/brain" },
    ),
  ).toEqual({ version: 1, readRoot: "/brain" });
});
