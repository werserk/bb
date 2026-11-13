import { z } from "zod";
export const clientSubmissionIdSchema = z
  .uuid()
  .transform((id) => id.toLowerCase());
export function clientSubmissionQueueId(id: string): string {
  return `qsub_${clientSubmissionIdSchema.parse(id)}`;
}
