import { getThread, getThreadPluginMetadata } from "@bb/db";
import type { ServiceTurnDescriptor } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

/**
 * Service input is accepted only from its authenticated plugin, into a target
 * that plugin manages, from a sender in the same project that it also manages.
 */
export function assertServiceTurnScope(
  deps: Pick<AppDeps, "db">,
  args: {
    callerPluginId: string | null;
    serviceTurn: ServiceTurnDescriptor;
    senderThreadId: string | null;
    thread: { id: string; projectId: string };
  },
): void {
  if (
    args.callerPluginId === null ||
    args.callerPluginId !== args.serviceTurn.origin.pluginId
  ) {
    throw new ApiError(
      403,
      "invalid_request",
      "Service input requires an authenticated plugin",
    );
  }
  const pluginId = args.callerPluginId;
  const managed = getThreadPluginMetadata(deps.db, args.thread.id, pluginId);
  const senderId = args.serviceTurn.origin.senderThreadId;
  const sender = senderId === null ? null : getThread(deps.db, senderId);
  const senderManaged = sender
    ? getThreadPluginMetadata(deps.db, sender.id, pluginId)
    : null;
  if (
    managed.corrupt ||
    Object.keys(managed.metadata).length === 0 ||
    senderId !== args.senderThreadId ||
    (senderId !== null &&
      (!sender ||
        sender.projectId !== args.thread.projectId ||
        !senderManaged ||
        senderManaged.corrupt ||
        Object.keys(senderManaged.metadata).length === 0))
  ) {
    throw new ApiError(
      403,
      "invalid_request",
      "Service input is outside the plugin managed scope",
    );
  }
}
