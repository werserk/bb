import { z } from "zod";
import { threadEventPlanStepSchema } from "./provider-event.js";

const threadTimelinePendingTodoItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
export type ThreadTimelinePendingTodoItemStatus = z.infer<
  typeof threadTimelinePendingTodoItemStatusSchema
>;

const threadTimelinePendingTodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: threadTimelinePendingTodoItemStatusSchema,
  note: threadEventPlanStepSchema.shape.note,
  actor: threadEventPlanStepSchema.shape.actor,
});
export type ThreadTimelinePendingTodoItem = z.infer<
  typeof threadTimelinePendingTodoItemSchema
>;

export const threadTimelinePendingTodosSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  staleSince: z.number().optional(),
  items: z.array(threadTimelinePendingTodoItemSchema),
});
export type ThreadTimelinePendingTodos = z.infer<
  typeof threadTimelinePendingTodosSchema
>;
