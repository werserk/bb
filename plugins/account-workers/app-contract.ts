import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export function workspaceTag(threadId: string): string {
  return `workspace:${threadId}`;
}

const choiceSchema = z
  .object({
    agentHostId: z.string(),
    agentHostName: z.string(),
    workspaceHostId: z.string(),
    workspaceHostName: z.string(),
    root: z.string(),
    disabledReason: z.string().nullable(),
  })
  .strict();
export type WorkerChoice = z.infer<typeof choiceSchema>;

const threadWorkspaceSchema = z
  .object({
    bindingId: z.string(),
    agentHostId: z.string(),
    workspaceHostId: z.string(),
    workspaceHostName: z.string(),
    root: z.string(),
    branch: z.string().nullable(),
    issue: z.string().nullable(),
  })
  .strict();
export type ThreadWorkspace = z.infer<typeof threadWorkspaceSchema>;

const workspaceOptionSchema = z
  .object({
    workspaceHostId: z.string(),
    workspaceHostName: z.string(),
    root: z.string(),
    current: z.boolean(),
    disabledReason: z.string().nullable(),
  })
  .strict();
export type WorkspaceOption = z.infer<typeof workspaceOptionSchema>;

export const accountWorkersAppContract = defineRpcContract({
  choices: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ choices: z.array(choiceSchema) }).strict(),
  },
  threadWorkspace: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ workspace: threadWorkspaceSchema.nullable() }).strict(),
    tags: (input) => [workspaceTag(input.threadId)],
  },
  workspaceOptions: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ options: z.array(workspaceOptionSchema) }).strict(),
    tags: (input) => [workspaceTag(input.threadId)],
  },
  rebind: {
    input: z.object({ threadId: z.string().min(1), workspaceHostId: z.string().min(1) }).strict(),
    output: z.object({ workspace: threadWorkspaceSchema }).strict(),
  },
});
