import { z } from "zod";

export const sourceRefSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const factSchema = z
  .object({
    text: z.string().trim().min(1).max(400),
    sources: z.array(sourceRefSchema).min(1).max(4),
  })
  .strict();
export const taskStateSchema = z
  .object({
    goal: factSchema.nullable(),
    criteria: z
      .array(factSchema.extend({ status: z.enum(["accepted", "proposed"]) }))
      .max(8),
    constraints: z.array(factSchema).max(8),
    reportedProgress: z.array(factSchema).max(8),
    visibleEvidence: z.array(factSchema).max(8),
    remainingWork: z.array(factSchema).max(8),
    blockers: z.array(factSchema).max(4),
    goalChanges: z.array(factSchema).max(4),
    contextComplete: z.boolean(),
  })
  .strict()
  .refine(
    (state) => JSON.stringify(state).length <= 6000,
    "Task state exceeds 6000 characters",
  );
export type TaskState = z.infer<typeof taskStateSchema>;
export type SourceMessage = {
  messageId: string;
  revision: string;
  role: "user" | "assistant";
  text: string;
  sequence: number;
};
export type TaskMemory = {
  state: TaskState;
  sources: SourceMessage[];
  boundary: number | null;
};

export function emptyTaskState(): TaskState {
  return {
    goal: null,
    criteria: [],
    constraints: [],
    reportedProgress: [],
    visibleEvidence: [],
    remainingWork: [],
    blockers: [],
    goalChanges: [],
    contextComplete: false,
  };
}

export function stateSources(state: TaskState) {
  return [
    ...(state.goal ? [state.goal] : []),
    ...state.criteria,
    ...state.constraints,
    ...state.reportedProgress,
    ...state.visibleEvidence,
    ...state.remainingWork,
    ...state.blockers,
    ...state.goalChanges,
  ].flatMap((fact) => fact.sources);
}

export function validateStateSources(
  state: TaskState,
  messages: readonly SourceMessage[],
) {
  const available = new Set(
    messages.map((message) => `${message.messageId}:${message.revision}`),
  );
  if (
    stateSources(state).some(
      (source) => !available.has(`${source.messageId}:${source.revision}`),
    )
  )
    throw new Error("Task state references an unavailable source");
}

export function rememberTask(
  state: TaskState,
  messages: readonly SourceMessage[],
  boundary: number | null,
): TaskMemory {
  validateStateSources(state, messages);
  const ids = new Set(stateSources(state).map((source) => source.messageId));
  return {
    state,
    sources: messages.filter((message) => ids.has(message.messageId)),
    boundary,
  };
}
