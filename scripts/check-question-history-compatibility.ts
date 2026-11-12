import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "../packages/db/src/index.js";
import { createMigratedConnection } from "../packages/db/src/testing.js";
import {
  parseStoredThreadEvent,
  PERSONAL_PROJECT_ID,
  threadScope,
} from "../packages/domain/src/index.js";

const [previousPath, baselineRef, label] = process.argv.slice(2);
assert(
  previousPath && baselineRef && label,
  "Usage: previous-checkout baseline-ref label",
);
const previous = resolve(previousPath);
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: previous, encoding: "utf8" }).trim();
const oldHead = git(["rev-parse", "HEAD"]);
const baseline = git(["rev-parse", baselineRef]);
git([
  "diff",
  "--exit-code",
  baseline,
  "HEAD",
  "--",
  "packages/db",
  "packages/domain",
]);
git(["diff", "--exit-code", "HEAD", "--", "packages/db", "packages/domain"]);
const old = await import(
  pathToFileURL(resolve(previous, "packages/db/src/index.ts")).href
);
const oldDomain = await import(
  pathToFileURL(resolve(previous, "packages/domain/src/index.ts")).href
);
const event = {
  type: "client/turn/requested" as const,
  threadId: "thread-compat",
  scope: threadScope(),
  data: {
    direction: "outbound",
    requestId: "creq_23456789ab",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input: [{ type: "text", text: "owner answer", mentions: [] }],
    target: { kind: "auto", expectedTurnId: "turn-before" },
    request: { method: "turn/start", params: {} },
    execution: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
  },
};
const legacyEvent = oldDomain.parseStoredThreadEvent(event);
assert.deepEqual(parseStoredThreadEvent(event), legacyEvent);
const linkedEvent = {
  ...event,
  data: {
    ...event.data,
    questionResponse: {
      questionId: "qst_23456789ab",
      revision: 1,
      queuedMessageId: "qmsg_23456789ab",
    },
  },
};
assert.deepEqual(oldDomain.parseStoredThreadEvent(linkedEvent), legacyEvent);
const candidateEvent = parseStoredThreadEvent(linkedEvent);
assert(candidateEvent.type === "client/turn/requested");
assert.deepEqual(
  candidateEvent.questionResponse,
  linkedEvent.data.questionResponse,
);
const db = createMigratedConnection();
try {
  const thread = old.createThread(db, old.noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    status: "idle",
  });
  const question = old.createConversationQuestion(db, {
    threadId: thread.id,
    sourceTurnId: "turn-before",
    sourceCallId: "question-before",
    publication: "{}",
    materialManifest: "[]",
  });
  assert(question);
  const input = {
    threadId: thread.id,
    content: [{ type: "text", text: "frozen answer", mentions: [] }],
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full" as const,
    serviceTier: "default",
    waitingOn: { kind: "thread-busy" as const },
    sendAt: null,
    payload: {
      kind: "questionResponse" as const,
      questionId: question.id,
      revision: 1,
    },
    systemNotice: null,
  };
  const first = old.createQueuedThreadMessageInTransaction(db, input);
  old.setConversationQuestionTerminal(db, {
    threadId: thread.id,
    questionId: question.id,
    revision: 1,
    status: "answered",
    response: "{}",
    queuedMessageId: first.id,
  });
  const upgraded = candidate.createConnection(db.$client.serialize());
  try {
    assert.equal(
      candidate.getConversationQuestion(upgraded, {
        threadId: thread.id,
        questionId: question.id,
      })?.queuedMessageId,
      first.id,
    );
    const claimed = candidate.claimNextQueuedThreadMessageGroup(
      upgraded,
      candidate.noopNotifier,
      thread.id,
      () => true,
    );
    assert(claimed?.length === 1);
    assert(
      upgraded.transaction((tx) =>
        candidate.deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: claimed,
        }),
      ),
    );
    assert(
      candidate.getConversationQuestion(upgraded, {
        threadId: thread.id,
        questionId: question.id,
      })?.dispatchedAt !== null,
    );
    const replacement = candidate.createQueuedThreadMessageInTransaction(
      upgraded,
      input,
    );
    assert(
      candidate.restoreConversationQuestionDelivery(upgraded, {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
        previousQueuedMessageId: first.id,
        queuedMessageId: replacement.id,
      }),
    );
    const rolledBack = old.createConnection(upgraded.$client.serialize());
    try {
      const card = old.getConversationQuestion(rolledBack, {
        threadId: thread.id,
        questionId: question.id,
      });
      assert.equal(card.queuedMessageId, replacement.id);
      assert.equal(card.dispatchedAt, null);
      const restored = old.getQueuedThreadMessage(rolledBack, replacement.id);
      assert.equal(restored.questionId, question.id);
      assert.equal(restored.payloadKind, "questionResponse");
      const rollbackClaim = old.claimNextQueuedThreadMessageGroup(
        rolledBack,
        old.noopNotifier,
        thread.id,
        () => true,
      );
      assert(rollbackClaim?.length === 1);
      assert(
        rolledBack.transaction((tx: unknown) =>
          old.deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
            queuedMessages: rollbackClaim,
          }),
        ),
      );
      assert(
        old.getConversationQuestion(rolledBack, {
          threadId: thread.id,
          questionId: question.id,
        }).dispatchedAt !== null,
      );
      const reupgraded = candidate.createConnection(
        rolledBack.$client.serialize(),
      );
      try {
        assert(
          candidate.getConversationQuestion(reupgraded, {
            threadId: thread.id,
            questionId: question.id,
          })?.dispatchedAt !== null,
        );
        assert.equal(
          candidate.listQueuedThreadMessages(reupgraded, thread.id).length,
          0,
        );
      } finally {
        reupgraded.$client.close();
      }
    } finally {
      rolledBack.$client.close();
    }
  } finally {
    upgraded.$client.close();
  }
  console.log(
    JSON.stringify({
      label,
      baseline,
      sourceCheckout: oldHead,
      sourceEquivalence:
        "packages/db and packages/domain unchanged against baseline",
      legacyEventUnchanged: true,
      oldReaderIgnoresNewMetadata: true,
      upgradePreservesQueue: true,
      rollbackConsumesRestoredQuestionAndRecordsReceipt: true,
      reupgradePreservesReceipt: true,
      missing: "installed runtime upgrade/rollback remains a separate gate",
    }),
  );
} finally {
  db.$client.close();
}
