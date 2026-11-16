import { describe, expect, it } from "vitest";
import { codexAiCatalogSchema } from "./generation-catalog.js";

describe("Codex explicit generation catalog", () => {
  it("preserves native reasoning including none and maps advertised Fast", () => {
    expect(
      codexAiCatalogSchema.parse({
        data: [
          {
            model: "sample",
            displayName: "Sample",
            supportedReasoningEfforts: [
              { reasoningEffort: "none" },
              { reasoningEffort: "low" },
              { reasoningEffort: "low" },
            ],
            serviceTiers: [{ id: "priority", name: "Fast" }, "fast"],
          },
        ],
      }),
    ).toEqual([
      {
        id: "sample",
        displayName: "Sample",
        reasoningEfforts: ["none", "low"],
        serviceTiers: ["fast"],
      },
    ]);
  });

  it("never invents reasoning or Fast when capabilities are absent", () => {
    expect(codexAiCatalogSchema.parse({ data: [{ model: "sample" }] })).toEqual(
      [
        {
          id: "sample",
          displayName: "sample",
          reasoningEfforts: [],
          serviceTiers: [],
        },
      ],
    );
  });

  it("uses additional speed tiers only without the authoritative tier list", () => {
    const parse = (serviceTiers?: string[]) =>
      codexAiCatalogSchema.parse({
        data: [
          { model: "sample", serviceTiers, additionalSpeedTiers: ["fast"] },
        ],
      })[0]?.serviceTiers;
    expect(parse()).toEqual(["fast"]);
    expect(parse([])).toEqual([]);
  });

  it("rejects malformed capabilities instead of treating them as defaults", () => {
    expect(() =>
      codexAiCatalogSchema.parse({
        data: [{ model: "sample", serviceTiers: [{ id: 2 }] }],
      }),
    ).toThrow();
    expect(() => codexAiCatalogSchema.parse({ data: null })).toThrow();
  });
});
