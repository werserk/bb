import {
  defineRpcContract,
  experimental_AI_MODEL_ID_MAX_LENGTH,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
export const gatewayContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      baseUrl: z.string(),
      models: z.array(
        z.object({
          id: z.string().max(experimental_AI_MODEL_ID_MAX_LENGTH),
          displayName: z.string(),
          provider: z.string(),
          hostId: z.string(),
          profile: z.string(),
        }),
      ),
    }),
  },
});
