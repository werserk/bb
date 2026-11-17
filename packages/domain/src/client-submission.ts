import { z } from "zod";
export const clientSubmissionIdSchema = z.uuid();
export function clientSubmissionQueueId(id: string): string {
  return `qsub_${clientSubmissionIdSchema.parse(id)}`;
}
