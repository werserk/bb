import {
  USER_QUESTION_MAX_QUESTIONS,
  USER_QUESTION_MAX_OPTIONS,
} from "./pending-interactions.js";

export const QUESTION_CARD_LIMITS = {
  total: 3000,
  body: 1500,
  prompt: 500,
  shortLabel: 80,
  optionLabel: 120,
  description: 300,
  materialLabel: 120,
  metadata: 128,
  materials: 20,
  dependencies: 100,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function codePoints(value: string): number {
  let count = 0;
  for (const _point of value) count++;
  return count;
}
function excess(
  field: string,
  actual: number,
  limit: number,
  unit: string,
): string | null {
  return actual > limit
    ? `Question card ${field}: ${actual}/${limit} ${unit}. Shorten the question and put the full report in materials.`
    : null;
}
export function questionPublicationSizeError(input: unknown): string | null {
  const card = record(input);
  let total = 0;
  function text(
    field: string,
    value: unknown,
    limit: number,
    visible = true,
  ): string | null {
    if (typeof value !== "string") return null;
    const actual = codePoints(value);
    if (visible) total += actual;
    return excess(field, actual, limit, "code points");
  }
  const body = text("body", card.body, QUESTION_CARD_LIMITS.body);
  if (body) return body;
  if (Array.isArray(card.questions)) {
    const count = excess(
      "questions",
      card.questions.length,
      USER_QUESTION_MAX_QUESTIONS,
      "items",
    );
    if (count) return count;
    for (const [index, value] of card.questions.entries()) {
      const q = record(value);
      const prefix = `questions[${index}]`;
      for (const error of [
        text(
          `${prefix}.prompt`,
          q.prompt ?? q.question,
          QUESTION_CARD_LIMITS.prompt,
        ),
        text(
          `${prefix}.shortLabel`,
          q.shortLabel ?? q.header,
          QUESTION_CARD_LIMITS.shortLabel,
        ),
        text(`${prefix}.id`, q.id, QUESTION_CARD_LIMITS.metadata, false),
      ])
        if (error) return error;
      if (!Array.isArray(q.options)) continue;
      const count = excess(
        `${prefix}.options`,
        q.options.length,
        USER_QUESTION_MAX_OPTIONS,
        "items",
      );
      if (count) return count;
      for (const [optionIndex, value] of q.options.entries()) {
        const option = record(value);
        const path = `${prefix}.options[${optionIndex}]`;
        const description =
          "question" in q
            ? [option.description, option.preview]
                .filter((v): v is string => typeof v === "string" && Boolean(v))
                .join("\n\n")
            : option.description;
        for (const error of [
          text(`${path}.label`, option.label, QUESTION_CARD_LIMITS.optionLabel),
          text(
            `${path}.description`,
            description,
            QUESTION_CARD_LIMITS.description,
          ),
          text(
            `${path}.value`,
            option.value,
            QUESTION_CARD_LIMITS.metadata,
            false,
          ),
        ])
          if (error) return error;
      }
    }
  }
  if (Array.isArray(card.materials)) {
    const count = excess(
      "materials",
      card.materials.length,
      QUESTION_CARD_LIMITS.materials,
      "items",
    );
    if (count) return count;
    for (const [index, value] of card.materials.entries()) {
      const material = record(value);
      const label = text(
        `materials[${index}].label`,
        material.label,
        QUESTION_CARD_LIMITS.materialLabel,
      );
      if (label) return label;
      if (Array.isArray(material.dependencies)) {
        const count = excess(
          `materials[${index}].dependencies`,
          material.dependencies.length,
          QUESTION_CARD_LIMITS.dependencies,
          "items",
        );
        if (count) return count;
      }
    }
  }
  return excess("total", total, QUESTION_CARD_LIMITS.total, "code points");
}
