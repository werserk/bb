import { expect, it } from "vitest";
import { canonicalPlacementPayload, sha256Digest } from "@bb/domain";
import { placementRequestV1Schema } from "../src/api/placement.js";
it("retry cannot substitute failed input or choose another binding", () => {
  const request = {
    schemaVersion: 1,
    submissionKey: "key",
    intent: {
      kind: "retry",
      failedOperationId: "failed",
      consentId: "consent",
    },
  };
  expect(placementRequestV1Schema.parse(request)).toEqual(request);
  for (const replacement of [
    { input: "replacement" },
    { request: { mode: "auto", input: "replacement" } },
    { selection: { mode: "auto" } },
    { model: "other" },
    { workspace: { hostId: "other" } },
  ])
    expect(
      placementRequestV1Schema.safeParse({
        ...request,
        intent: { ...request.intent, ...replacement },
      }).success,
    ).toBe(false);
  expect(
    placementRequestV1Schema.safeParse({ ...request, principalScope: "owner" })
      .success,
  ).toBe(false);
});
it("transport key does not enter the digest of validated payload", () => {
  const first = placementRequestV1Schema.parse({
    schemaVersion: 1,
    submissionKey: "one",
    intent: {
      kind: "continuation",
      threadId: "thread",
      request: { mode: "auto", input: [{ type: "text", text: "original" }] },
    },
  });
  const second = placementRequestV1Schema.parse({
    ...first,
    submissionKey: "two",
  });
  expect(sha256Digest(canonicalPlacementPayload(first))).toBe(
    sha256Digest(canonicalPlacementPayload(second)),
  );
  expect(canonicalPlacementPayload(first)).not.toContain("submissionKey");
});
