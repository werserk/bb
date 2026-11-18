import { expect, it } from "vitest";
import {
  clientSubmissionIdSchema,
  clientSubmissionQueueId,
} from "../src/client-submission.js";

it("normalizes accepted UUID casing before admission identity and queue key derivation", () => {
  const lower = "f36a779e-d653-4bf7-968c-05844eb7230a";
  expect(clientSubmissionIdSchema.parse(lower.toUpperCase())).toBe(lower);
  expect(clientSubmissionQueueId(lower.toUpperCase())).toBe(
    clientSubmissionQueueId(lower),
  );
});
