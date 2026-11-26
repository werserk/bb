import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const nativeObservationSchema = z
  .object({
    generation: z.string(),
    epoch: z.string(),
    lock: z.enum(["free", "held", "unknown"]),
    threadId: z.string().nullable(),
  })
  .strict();
export const nativeHostContract = defineRpcContract({
  status: { input: z.null(), output: nativeObservationSchema },
});
