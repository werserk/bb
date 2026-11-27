import { z } from "zod";
export const clientSubmissionIdSchema = z
  .uuid()
  .transform((id) => id.toLowerCase());
export function clientSubmissionQueueId(id: string): string {
  return `qsub_${clientSubmissionIdSchema.parse(id)}`;
}
export function createClientSubmissionId(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function clientSubmissionIdTime(id: string): number | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.exec(
    id,
  );
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : undefined;
}
