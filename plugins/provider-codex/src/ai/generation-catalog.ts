import { z } from "zod";

const capabilityId = z.string().min(1).max(64);
const serviceTier = z.union([
  capabilityId,
  z.object({ id: capabilityId }).transform((value) => value.id),
]);

export const codexAiCatalogSchema = z
  .object({
    data: z
      .array(
        z.object({
          model: z.string().min(1).max(512),
          displayName: z.string().min(1).max(256).nullish(),
          supportedReasoningEfforts: z
            .array(z.object({ reasoningEffort: capabilityId }))
            .max(32)
            .nullish(),
          serviceTiers: z.array(serviceTier).max(32).nullish(),
          additionalSpeedTiers: z.array(serviceTier).max(32).nullish(),
        }),
      )
      .max(2048),
  })
  .transform(({ data }) =>
    data.map((model) => ({
      id: model.model,
      displayName: model.displayName ?? model.model,
      reasoningEfforts: [
        ...new Set(
          (model.supportedReasoningEfforts ?? []).map(
            (effort) => effort.reasoningEffort,
          ),
        ),
      ],
      serviceTiers: [
        ...new Set(
          (model.serviceTiers ?? model.additionalSpeedTiers ?? []).map(
            (tier) => (tier === "priority" ? "fast" : tier),
          ),
        ),
      ],
    })),
  );
