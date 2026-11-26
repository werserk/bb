import { eq } from "drizzle-orm";
import {
  threadScope,
  flattenPromptInputGroups,
  type TurnRequestEventData,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import { appendStoredThreadEventInTransaction } from "../../src/data/events.js";
import { readPlacementOperation } from "../../src/data/placement-operations.js";
import {
  readPlacementActionReceipt,
  readPlacementQueueAttempts,
} from "../../src/data/placement-action-receipts.js";
import {
  claimQueuedThreadMessageGroup,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
} from "../../src/data/queued-thread-messages.js";
import {
  commitPlacementOrdinaryDispatch,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
  settlePlacementExecutionCommand,
} from "../../src/data/placement-dispatch-receipts.js";
import { purpose } from "./placement.js";
export const fixtureExecution = {
  model: "model",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "auto",
  source: "client/thread/start",
} as const;
export const fixtureCommand = {
  agentHostId: "agent-host",
  agentSessionId: "session-1",
  nativeExecutionId: "execution-1",
  commandId: "command-1",
};
export function claimFixture(db: DbConnection, qid: string) {
  const claimed = claimQueuedThreadMessageGroup(db, noopNotifier, qid, {
    kind: "explicit-send",
  });
  if (!claimed?.length) throw new Error("fixture claim failed");
  return claimed;
}
export function appendFixture(
  tx: DbTransaction,
  owner: string,
  claimed: ReturnType<typeof claimFixture>,
  requestId: string,
  patch: Partial<TurnRequestEventData> = {},
  fence = 1,
) {
  const threadId = claimed[0]!.threadId;
  const inputGroups = claimed.map((q) => JSON.parse(q.content));
  const body: TurnRequestEventData = {
    requestId,
    direction: "outbound",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    dispatchProvenance: {
      origin: null,
      originPluginId: null,
      requestedBy: null,
    },
    target: { kind: "auto", expectedTurnId: null },
    inputGroups,
    input: flattenPromptInputGroups(inputGroups),
    execution: fixtureExecution,
    request: { method: "turn/start", params: {} },
    clientSubmissions: claimed.flatMap((q, inputGroupIndex) =>
      readPlacementQueueAttempts(tx, q.id).map((m) => ({
        id: readPlacementActionReceipt(tx, m.op)!.submissionUuid!,
        inputGroupIndex,
      })),
    ),
    sourceQueuedMessageIds: claimed.map((q) => q.id),
    ...patch,
  };
  const requestSequence = appendStoredThreadEventInTransaction(tx, {
    threadId,
    scope: threadScope(),
    type: "client/turn/requested",
    data: body,
  });
  const guard = {
    threadId,
    requestId,
    fence,
    purpose,
    executionOwnerOperationId: owner,
  };
  const receipt = commitPlacementOrdinaryDispatch(tx, {
    ...guard,
    requestSequence,
    claimed,
  });
  if (
    !deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
      queuedMessages: claimed,
    })
  )
    throw new Error("lost claim");
  return { receipt, guard, body };
}
export function failFixture(db: DbConnection, owner: string) {
  const op = readPlacementOperation(db, owner)!;
  const claimed = claimFixture(db, op.queueReceipt!.queuedMessageId);
  const { guard } = db.transaction(
    (tx) => appendFixture(tx, owner, claimed, "creq_2222222222"),
    { behavior: "immediate" },
  );
  const command = { ...guard, ...fixtureCommand };
  if (
    preparePlacementExecutionCommand(db, command).kind !== "prepared" ||
    claimPlacementExecutionCommand(db, {
      ...command,
      currentAgentSessionId: command.agentSessionId,
    }).kind !== "won"
  )
    throw new Error("fixture command failed");
  db.transaction(
    (tx) => {
      if (
        !settlePlacementExecutionCommand(tx, {
          ...command,
          outcome: "failed_accepted",
        })
      )
        throw new Error("fixture settle failed");
      tx.update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, guard.threadId))
        .run();
    },
    { behavior: "immediate" },
  );
  return guard.requestId;
}
