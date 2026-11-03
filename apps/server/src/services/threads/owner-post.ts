import { getThread, raiseThreadAttention } from "@bb/db";
import type { ToolCallResponse } from "@bb/domain";
import type { PluginRowPresentation } from "@get-bb/plugin-sdk";
import type { AppDeps } from "../../types.js";
import { emitPluginThreadOwnerPost } from "../plugins/plugin-thread-events.js";

interface RaiseOwnerPostAttentionArgs {
  input: unknown;
  presentation: PluginRowPresentation | null;
  response: ToolCallResponse;
  threadId: string;
}

function ownerPostInputText(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const text = (input as { text?: unknown }).text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

export function raiseOwnerPostAttention(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RaiseOwnerPostAttentionArgs,
): void {
  if (args.presentation?.experimental_ownerPost !== true) return;
  if (!args.response.success) return;
  const text = ownerPostInputText(args.input);
  if (text === null) return;
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    return;
  }
  const raised = raiseThreadAttention(deps.db, deps.hub, args.threadId);
  if (raised) emitPluginThreadOwnerPost(raised, text);
}
