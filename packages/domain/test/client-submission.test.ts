import { expect, it } from "vitest";
import {
  clientSubmissionIdSchema,
  clientSubmissionIdTime,
  clientSubmissionQueueId,
  createClientSubmissionId,
} from "../src/client-submission.js";

it("normalizes accepted UUID casing before admission identity and queue key derivation", () => {
  const lower = "f36a779e-d653-4bf7-968c-05844eb7230a";
  expect(clientSubmissionIdSchema.parse(lower.toUpperCase())).toBe(lower);
  expect(clientSubmissionQueueId(lower.toUpperCase())).toBe(
    clientSubmissionQueueId(lower),
  );
});

it("creates time-ordered v7 submission ids that admission can date", () => {
  const now = Date.UTC(2026, 10, 27, 12, 30, 45, 123);
  const id = createClientSubmissionId(now);
  expect(clientSubmissionIdSchema.parse(id)).toBe(id);
  expect(id[14]).toBe("7");
  expect(clientSubmissionIdTime(id)).toBe(now);
  expect(clientSubmissionIdTime(id.toUpperCase())).toBe(now);
  expect(createClientSubmissionId(now)).not.toBe(id);
  expect(clientSubmissionIdTime(crypto.randomUUID())).toBeUndefined();
  expect(clientSubmissionIdTime("not-a-uuid")).toBeUndefined();
});
