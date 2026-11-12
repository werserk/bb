import {
  QUESTION_CARD_LIMITS,
  questionPublicationSizeError,
} from "./conversation-question-limits.js";
import { conversationQuestionIdSchema } from "./protocol-ids.js";
import { z } from "zod";
import { questionResolutionHistoryFields } from "./question-resolution-attribution.js";
import {
  userQuestionPendingInteractionPayloadSchema,
  userQuestionPendingInteractionResolutionSchema,
  type PendingInteractionUserAnswer,
  type PendingInteractionUserQuestionQuestion,
} from "./pending-interactions.js";

export const CONVERSATION_QUESTION_TOOL_NAME = "bb_ask_question";

export const conversationQuestionStatusSchema = z.enum([
  "open",
  "answered",
  "dismissed",
  "withdrawn",
]);
export type ConversationQuestionStatus = z.infer<
  typeof conversationQuestionStatusSchema
>;

export const questionMaterialPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(path) &&
      !/[\0?#]/u.test(path) &&
      path
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Question materials must use contained thread-storage relative paths",
  );

export const conversationQuestionMaterialInputSchema = z.strictObject({
  path: questionMaterialPathSchema,
  label: z.string().trim().min(1).max(300),
  dependencies: z
    .array(questionMaterialPathSchema)
    .max(QUESTION_CARD_LIMITS.dependencies)
    .default([]),
});

export const conversationQuestionPublicationSchema = z
  .strictObject({
    body: z.string().max(65536).default(""),
    questions: userQuestionPendingInteractionPayloadSchema.shape.questions,
    materials: z
      .array(conversationQuestionMaterialInputSchema)
      .max(QUESTION_CARD_LIMITS.materials)
      .default([]),
  })
  .superRefine((publication, context) => {
    const questionResult =
      userQuestionPendingInteractionPayloadSchema.safeParse({
        kind: "user_question",
        questions: publication.questions,
      });
    if (!questionResult.success) {
      for (const issue of questionResult.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
    }
    const paths = publication.materials.map((material) => material.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["materials"],
        message: "Question material paths must be unique",
      });
    }
  });
export const conversationQuestionPublicationInputSchema = z.preprocess(
  (input, context) => {
    const error = questionPublicationSizeError(input);
    if (error) context.addIssue({ code: "custom", message: error });
    return input;
  },
  conversationQuestionPublicationSchema,
);

export function parseConversationQuestionPublication(
  input: unknown,
): ConversationQuestionPublication {
  const parsed = conversationQuestionPublicationInputSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid question publication",
    );
  return parsed.data;
}

export type ConversationQuestionPublication = z.infer<
  typeof conversationQuestionPublicationSchema
>;

export function normalizeConversationQuestionAnswers(
  questions: readonly PendingInteractionUserQuestionQuestion[],
  input: Record<string, PendingInteractionUserAnswer>,
): Record<string, PendingInteractionUserAnswer> {
  const parsed = userQuestionPendingInteractionResolutionSchema.safeParse({
    kind: "user_answer",
    answers: input,
  });
  if (!parsed.success)
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid question answer",
    );
  const { answers } = parsed.data;
  const known = new Set(questions.map((question) => question.id));
  for (const id of Object.keys(answers)) {
    if (!known.has(id))
      throw new Error(`Answer references unknown question '${id}'`);
  }
  const normalized: Record<string, PendingInteractionUserAnswer> = {};
  for (const question of [...questions].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const answer = answers[question.id];
    if (!answer) {
      if (question.required)
        throw new Error(`Missing answer for question '${question.id}'`);
      continue;
    }
    if (new Set(answer.selected).size !== answer.selected.length)
      throw new Error(
        `Answer for question '${question.id}' contains duplicate selections`,
      );
    if (answer.selected.length > (question.options?.length ?? 0))
      throw new Error(
        `Answer for question '${question.id}' selects more options than are available`,
      );
    if (!question.multiSelect && answer.selected.length > 1)
      throw new Error(
        `Question '${question.id}' accepts only one selected option`,
      );
    const available = new Set(
      (question.options ?? []).map((option) => option.value),
    );
    if (answer.selected.some((value) => !available.has(value)))
      throw new Error(
        `Answer for question '${question.id}' selected an unavailable option`,
      );
    if (!question.allowFreeText && answer.freeText !== undefined)
      throw new Error(
        `Question '${question.id}' does not accept free-text answers`,
      );
    if (
      question.required &&
      answer.selected.length === 0 &&
      answer.freeText === undefined
    )
      throw new Error(
        `Question '${question.id}' must include a selected option or free-text answer`,
      );
    normalized[question.id] = {
      selected: [...answer.selected].sort(),
      ...(answer.freeText === undefined ? {} : { freeText: answer.freeText }),
    };
  }
  return normalized;
}

export const frozenQuestionFileSchema = z.object({
  originalPath: questionMaterialPathSchema,
  snapshotPath: questionMaterialPathSchema,
  label: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotRevision: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
});
export const questionMaterialManifestSchema = z.object({
  hostId: z.string().nullable(),
  storageRootPath: z.string().nullable(),
  materials: z.array(
    frozenQuestionFileSchema.extend({
      dependencies: z.array(questionMaterialPathSchema),
    }),
  ),
  files: z.array(frozenQuestionFileSchema),
});
export type FrozenQuestionFile = z.infer<typeof frozenQuestionFileSchema>;
export type QuestionMaterialManifest = z.infer<
  typeof questionMaterialManifestSchema
>;
export const conversationQuestionAnswerSchema = z.strictObject({
  revision: z.number().int().positive(),
  answers: userQuestionPendingInteractionResolutionSchema.shape.answers,
});
export type ConversationQuestionAnswer = z.infer<
  typeof conversationQuestionAnswerSchema
>;
export const conversationQuestionVersionSchema = z.strictObject({
  revision: z.number().int().positive(),
});
export const conversationQuestionSchema = z.object({
  ...questionResolutionHistoryFields,
  id: conversationQuestionIdSchema,
  threadId: z.string(),
  revision: z.number().int().positive(),
  sourceTurnId: z.string().nullable(),
  sourceCallId: z.string().nullable(),
  status: conversationQuestionStatusSchema,
  publication: conversationQuestionPublicationSchema,
  materialManifest: questionMaterialManifestSchema,
  response:
    userQuestionPendingInteractionResolutionSchema.shape.answers.nullable(),
  queuedMessageId: z.string().nullable(),
  dispatchedAt: z.number().nullable(),
  delivery: z.object({
    kind: z.enum(["none", "queued", "held", "submitted", "removed"]),
    reason: z.string().nullable(),
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ConversationQuestion = z.infer<typeof conversationQuestionSchema>;

const nativePublicationSchema = z.strictObject({
  body: z.string().max(65536).default(""),
  materials: conversationQuestionPublicationSchema.shape.materials,
  questions: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        header: z.string().optional(),
        multiSelect: z.boolean().default(false),
        options: z
          .array(
            z.strictObject({
              label: z.string().min(1),
              description: z.string().optional(),
              preview: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(10),
});
export const conversationQuestionToolInputSchema = z.strictObject({
  body: conversationQuestionPublicationSchema.shape.body,
  materials: conversationQuestionPublicationSchema.shape.materials,
  questions: z.union([
    conversationQuestionPublicationSchema.shape.questions,
    nativePublicationSchema.shape.questions,
  ]),
});
export function normalizeConversationQuestionPublication(
  input: unknown,
): ConversationQuestionPublication {
  const sizeError = questionPublicationSizeError(input);
  if (sizeError) throw new Error(sizeError);
  const parsed = conversationQuestionToolInputSchema.parse(input);
  if (parsed.questions.every((question) => "prompt" in question))
    return parseConversationQuestionPublication(parsed);
  const native = nativePublicationSchema.parse(parsed);
  return parseConversationQuestionPublication({
    ...native,
    questions: native.questions.map((question, index) => ({
      id: `question_${index + 1}`,
      prompt: question.question,
      shortLabel: question.header,
      multiSelect: question.multiSelect,
      allowFreeText: true,
      required: true,
      options: question.options?.map((option, optionIndex) => ({
        value: `option_${optionIndex + 1}`,
        label: option.label,
        description:
          [option.description, option.preview].filter(Boolean).join("\n\n") ||
          undefined,
      })),
    })),
  });
}

export function conversationQuestionMarker(questionId: string): string {
  return `::question{id="${conversationQuestionIdSchema.parse(questionId)}"}`;
}
export function parseConversationQuestionMarker(text: string): string | null {
  return (
    /^::question\{id="(qst_[23456789abcdefghijkmnpqrstuvwxyz]{10})"\}$/u.exec(
      text,
    )?.[1] ?? null
  );
}
