import { z } from "zod";
import { jsonValueSchema, ProjectAttachmentError } from "@bb/domain";
import { ApiError } from "../../errors.js";

const intakeErrorOutcomeSchema = z.object({
  kind: z.literal("error"),
  status: z.custom<ApiError["status"]>(value => typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 500),
  body: z.object({ code: z.string(), message: z.string(), details: jsonValueSchema.optional(), retryable: z.boolean().optional() }),
});

export function deterministicIntakeError(error: unknown): ApiError | null {
  if (error instanceof ProjectAttachmentError) return new ApiError(400, "invalid_request", error.message);
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 ? error : null;
}

export function encodeIntakeErrorOutcome(error: ApiError, retainedIntakeId?: string): string {
  const body = retainedIntakeId === undefined ? error.body : { ...error.body, details: {
    ...(error.body.details === undefined ? {} : { originalDetails: error.body.details }),
    intakeId: retainedIntakeId, custodyRetained: true, recoveryRequired: true,
  } };
  return JSON.stringify({ kind: "error", status: error.status, body });
}

export function readIntakeErrorOutcome(value: unknown): ApiError | null {
  const parsed = intakeErrorOutcomeSchema.safeParse(value);
  if (!parsed.success) return null;
  return new ApiError(parsed.data.status, parsed.data.body.code, parsed.data.body.message, {
    ...(parsed.data.body.details === undefined ? {} : { details: parsed.data.body.details }),
    ...(parsed.data.body.retryable === undefined ? {} : { retryable: parsed.data.body.retryable }),
  });
}

export function intakeBlockedError(id: string, blockerId: string | null): ApiError {
  return new ApiError(409, "intake_blocked", "Send remains in server custody; preparation is blocked. Inspect its canonical intake before retrying.",
    { details: { intakeId: id, blockerId, custodyRetained: true } });
}
