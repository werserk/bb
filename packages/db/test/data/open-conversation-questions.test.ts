import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { createMigratedConnection } from "../../src/testing.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads, conversationQuestions, projects } from "../../src/schema.js";
import { createThread } from "../../src/data/threads.js";
import {
  createConversationQuestion,
  getOpenConversationQuestionSummary,
  listOpenConversationQuestionPage,
  listOpenConversationQuestionIdentities,
  hasOpenConversationQuestion,
} from "../../src/data/conversation-questions.js";

function fixture() {
  const db = createMigratedConnection();
  const thread = createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    status: "idle",
  });
  const add = (index: number, terminal = false) => {
    const row = createConversationQuestion(db, {
      id: `qst_${index.toString().padStart(5, "0")}`,
      threadId: thread.id,
      sourceTurnId: null,
      sourceCallId: null,
      publication: "{}",
      materialManifest: "[]",
    })!;
    db.update(conversationQuestions)
      .set({ createdAt: 1000, status: terminal ? "dismissed" : "open" })
      .where(eq(conversationQuestions.id, row.id))
      .run();
    return row.id;
  };
  return { db, thread, add };
}

it("keeps the oldest open target after more than 200 terminal cards", () => {
  const { db, thread, add } = fixture();
  try {
    const oldest = add(0);
    for (let i = 1; i <= 201; i++) add(i, true);
    expect(getOpenConversationQuestionSummary(db, thread.id)).toEqual({
      total: 1,
      firstQuestionId: oldest,
    });
    expect(
      listOpenConversationQuestionPage(db, {
        threadId: thread.id,
        limit: 100,
      }).map((row) => row.id),
    ).toEqual([oldest]);
  } finally {
    db.$client.close();
  }
});

it("traverses 201 open cards with equal timestamps exactly once", () => {
  const { db, thread, add } = fixture();
  try {
    const ids = Array.from({ length: 201 }, (_, index) => add(index));
    const page1 = listOpenConversationQuestionPage(db, {
      threadId: thread.id,
      limit: 100,
    });
    const last1 = page1.at(-1)!;
    const page2 = listOpenConversationQuestionPage(db, {
      threadId: thread.id,
      limit: 100,
      after: { createdAt: last1.createdAt, id: last1.id },
    });
    const last2 = page2.at(-1)!;
    const page3 = listOpenConversationQuestionPage(db, {
      threadId: thread.id,
      limit: 100,
      after: { createdAt: last2.createdAt, id: last2.id },
    });
    expect([page1.length, page2.length, page3.length]).toEqual([100, 100, 1]);
    expect([...page1, ...page2, ...page3].map((row) => row.id)).toEqual(
      [...ids].reverse(),
    );
    expect(getOpenConversationQuestionSummary(db, thread.id)).toEqual({
      total: 201,
      firstQuestionId: ids[0],
    });
    expect(listOpenConversationQuestionIdentities(db, thread.id)).toEqual(
      [...ids].reverse().map((id) => ({ id, revision: 1 })),
    );
  } finally {
    db.$client.close();
  }
});

it.each(["archivedAt", "deletedAt", "visibility"] as const)(
  "uses the same empty view for %s across summary, pages and existence without mutating rows",
  (field) => {
    const { db, thread, add } = fixture();
    try {
      const id = add(0);
      db.update(threads)
        .set(
          field === "visibility" ? { visibility: "hidden" } : { [field]: 1000 },
        )
        .where(eq(threads.id, thread.id))
        .run();
      expect(getOpenConversationQuestionSummary(db, thread.id)).toEqual({
        total: 0,
        firstQuestionId: null,
      });
      expect(
        listOpenConversationQuestionPage(db, {
          threadId: thread.id,
          limit: 100,
        }),
      ).toEqual([]);
      expect(listOpenConversationQuestionIdentities(db, thread.id)).toEqual([]);
      expect(hasOpenConversationQuestion(db, thread.id)).toBe(false);
      expect(
        db
          .select()
          .from(conversationQuestions)
          .where(eq(conversationQuestions.id, id))
          .get()?.status,
      ).toBe("open");
      db.update(threads)
        .set(
          field === "visibility"
            ? { visibility: "visible" }
            : { [field]: null },
        )
        .where(eq(threads.id, thread.id))
        .run();
      expect(getOpenConversationQuestionSummary(db, thread.id)).toEqual({
        total: 1,
        firstQuestionId: id,
      });
      expect(hasOpenConversationQuestion(db, thread.id)).toBe(true);
    } finally {
      db.$client.close();
    }
  },
);

it("does not expose questions from a deleted project or a different thread", () => {
  const { db, thread, add } = fixture();
  try {
    add(0);
    expect(getOpenConversationQuestionSummary(db, "missing")).toEqual({
      total: 0,
      firstQuestionId: null,
    });
    db.update(projects)
      .set({ deletedAt: 1000 })
      .where(eq(projects.id, thread.projectId))
      .run();
    expect(hasOpenConversationQuestion(db, thread.id)).toBe(false);
    expect(getOpenConversationQuestionSummary(db, thread.id)).toEqual({
      total: 0,
      firstQuestionId: null,
    });
  } finally {
    db.$client.close();
  }
});
