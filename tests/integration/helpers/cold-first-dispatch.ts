// Diagnostic sender. The final first-start storage capability is explicitly supplied by
// the isolated composition. There is no fallback to the earlier ordinary-only claim.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  events,
  placementBindings,
  readPlacementAdmittedExecution,
  readPlacementWorker,
  getThread,
  getActiveStoredTurnId,
  getStoredProviderSession,
  preparePlacementExecutionCommand,
  type DbConnection,
  type claimPlacementExecutionCommand,
} from "@bb/db";
import {
  canonicalJsonBytes,
  sha256Digest,
  turnRequestEventDataSchema,
  type PlacementBinding,
  type WorkspacePurpose,
} from "@bb/domain";
import {
  guestStartFrame271,
  type guestReport,
} from "@bb/host-daemon-contract/managed-guest-lab";
import type { z } from "zod";
import { createLiveHostCommandExecution } from "../../../apps/server/src/services/hosts/live-command.js";
import type { ColdDispatchKey } from "../../../apps/server/src/services/threads/cold-dispatch-lab.js";
import { readPendingThreadStartContext } from "../../../apps/server/src/services/threads/dispatch-attempt.js";
import type { NotificationHub } from "../../../apps/server/src/ws/hub.js";
import type { ColdGuestChannel } from "./cold-guest-channel.js";

type ColdClaimArgs = Parameters<typeof claimPlacementExecutionCommand>[1] & {
  firstStart: {
    eventId: string;
    requestDigest: string;
    readCurrentManifest(
      binding: PlacementBinding,
    ): {
      runtimeRootKey: string;
      launchProfileId: string;
      agentSessionId: string;
    } | null;
  };
};
type ClaimFirst = (
  db: DbConnection,
  args: ColdClaimArgs,
) => { kind: "refused" | "held" | "won" };
export function createColdFirstHandler(
  db: DbConnection,
  hub: NotificationHub,
  channel: ColdGuestChannel,
  claimFirst: ClaimFirst,
  recordGuestReport: (result: z.infer<typeof guestReport>) => void,
) {
  return async (
    key: ColdDispatchKey,
    purpose: Extract<WorkspacePurpose, { kind: "local-fixture" }>,
  ) => {
    const admitted = readPlacementAdmittedExecution(db, { ...key, purpose });
    if (!admitted) return "unsupported" as const;
    if (admitted.commandId !== null) return "recorded" as const;
    const member = admitted.members[0];
    const binding = admitted.binding;
    const ref = hub.captureDaemonConnection(binding.agentHostId);
    const manifest = ref && channel.readCurrentQualifiedManifest(binding, ref);
    if (!ref || !manifest || admitted.members.length !== 1 || !member)
      return "unsupported" as const;
    const row = db
      .select()
      .from(placementBindings)
      .where(eq(placementBindings.threadId, key.threadId))
      .get();
    const thread = getThread(db, key.threadId);
    const worker = readPlacementWorker(
      db,
      binding.ownerPluginId,
      binding.workerId,
    );
    const context = readPendingThreadStartContext({ db }, key.threadId);
    if (
      !row ||
      row.boundFromOperationId !== member.op ||
      row.runtimeRootKey !== manifest.runtimeRootKey ||
      row.sourceCheckpoint !== null ||
      row.sourceProviderThreadId !== null ||
      worker?.slotState !== "reserved" ||
      worker.observation.launchProfileId !== manifest.launchProfileId ||
      thread?.status !== "pending" ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      !context ||
      context.fork !== null ||
      context.environmentIntent.type !== "reuse" ||
      context.environmentIntent.environmentId !== thread.environmentId ||
      canonicalJsonBytes(context.execution) !==
        canonicalJsonBytes(admitted.execution) ||
      getActiveStoredTurnId(db, key.threadId) !== null ||
      getStoredProviderSession(db, key.threadId).kind !== "none"
    )
      return "unsupported" as const;
    const event = db
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.id, admitted.eventId),
          eq(events.threadId, key.threadId),
          eq(events.sequence, admitted.requestSequence),
          eq(events.type, "client/turn/requested"),
        ),
      )
      .get();
    if (!event) return "unsupported" as const;
    const parsed = turnRequestEventDataSchema.safeParse(JSON.parse(event.data));
    if (!parsed.success) return "unsupported" as const;
    const body = parsed.data,
      text = body.input[0];
    if (
      body.target.kind !== "thread-start" ||
      body.source !== "spawn" ||
      body.request.method !== "thread/start" ||
      body.requestId !== key.requestId ||
      body.input.length !== 1 ||
      text?.type !== "text" ||
      !text.text ||
      text.mentions.length ||
      canonicalJsonBytes([body.input]) !==
        canonicalJsonBytes(body.inputGroups ?? []) ||
      canonicalJsonBytes(body.clientSubmissions ?? []) !==
        canonicalJsonBytes([
          { id: member.submissionUuid, inputGroupIndex: 0 },
        ]) ||
      canonicalJsonBytes(body.sourceQueuedMessageIds ?? []) !==
        canonicalJsonBytes([member.queueId]) ||
      canonicalJsonBytes(body.execution) !==
        canonicalJsonBytes(admitted.execution)
    )
      return "unsupported" as const;
    const commandId = createLiveHostCommandExecution(ref.hostId).id;
    const frame = guestStartFrame271.parse({
      type: "host-rpc.request",
      requestId: randomUUID(),
      agentSessionId: ref.sessionId,
      command: {
        type: "managed.thread.start",
        ...key,
        commandId,
        binding,
        runtimeRootKey: manifest.runtimeRootKey,
        launchProfileId: manifest.launchProfileId,
        inputText: text.text,
        epoch: {
          executionOwnerOperationId: admitted.executionOwnerOperationId,
          fence: admitted.fence,
          transferRevision: 1,
        },
      },
    });
    const identity = {
      ...key,
      executionOwnerOperationId: admitted.executionOwnerOperationId,
      fence: admitted.fence,
      purpose,
      agentHostId: ref.hostId,
      agentSessionId: ref.sessionId,
      nativeExecutionId: commandId,
      commandId,
    };
    if (preparePlacementExecutionCommand(db, identity).kind !== "prepared")
      return "recorded" as const;
    const result = await channel.deliver(
      ref,
      frame,
      () =>
        claimFirst(db, {
          ...identity,
          currentAgentSessionId: ref.sessionId,
          firstStart: {
            eventId: admitted.eventId,
            requestDigest: sha256Digest(canonicalJsonBytes(body)),
            readCurrentManifest(currentBinding) {
              const now = channel.readCurrentQualifiedManifest(
                currentBinding,
                ref,
              );
              return now &&
                canonicalJsonBytes(now) === canonicalJsonBytes(manifest)
                ? {
                    agentSessionId: ref.sessionId,
                    runtimeRootKey: now.runtimeRootKey,
                    launchProfileId: now.launchProfileId,
                  }
                : null;
            },
          },
        }).kind === "won",
    );
    if (typeof result === "object") recordGuestReport(result);
    return "recorded" as const;
  };
}
