import { expect, it } from "vitest";
import { createFilePreviewRequestSchema } from "../src/api/files.js";

const expectedSource = { hostId: "h", canonicalReadRoot: "/original" };
it("requires paired strict policy/source for both variants and keeps legacy exact", () => {
  const legacy = { hostId: "h", rootPath: "/root" };
  expect(createFilePreviewRequestSchema.parse(legacy)).toEqual(legacy);
  for (const base of [
    legacy,
    { target: { kind: "thread-storage", threadId: "t", root: "nested" } },
  ]) {
    const strict = { ...base, policy: "artifact-v1", expectedSource };
    expect(createFilePreviewRequestSchema.parse(strict)).toEqual(strict);
    for (const invalid of [
      { ...base, expectedSource },
      { ...base, policy: "artifact-v1" },
      { ...strict, expectedSource: { ...expectedSource, extra: true } },
      {
        ...strict,
        expectedSource: { ...expectedSource, canonicalReadRoot: "relative" },
      },
    ])
      expect(createFilePreviewRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
  }
});
