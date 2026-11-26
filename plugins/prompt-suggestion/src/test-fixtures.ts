import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
export function fixture(
  options: {
    queued?: number;
    assistantText?: string;
    noHistory?: boolean;
    contextBoundary?: number;
    threadStatus?: "idle" | "active";
    turnId?: string;
    status?: "completed" | "failed";
    openQuestion?: boolean;
    interaction?: "question" | "approval";
    turnRow?: boolean;
    providerId?: string;
  } = {},
) {
  const base = {
    threadId: "thread",
    startedAt: 0,
    createdAt: 0,
    attachments: null,
  };
  const messages = [
    {
      ...base,
      id: "u",
      kind: "conversation" as const,
      role: "user" as const,
      text: "Fix the bug",
      messageSeq: 1,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      turnId: null,
      initiator: "user" as const,
      senderThreadId: null,
      systemMessageKind: "unlabeled" as const,
      systemMessageSubject: null,
      mentions: [],
      turnRequest: { kind: "message" as const, senderThreadId: null },
    },
    {
      ...base,
      id: "a",
      kind: "conversation" as const,
      role: "assistant" as const,
      text: "Fixed locally",
      messageSeq: 3,
      sourceSeqStart: 3,
      sourceSeqEnd: 3,
      turnId: "turn",
      turnRequest: null,
    },
  ];
  const host = createFakePluginHost({
    pluginId: "prompt-suggestion",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "thread",
            providerId: options.providerId ?? "codex",
            status: options.threadStatus ?? "idle",
            queuedMessageCount: options.queued ?? 0,
          }),
        timeline: async () => ({
          rows: options.noHistory
            ? []
            : options.turnRow
              ? [
                  ...messages.map((message) =>
                    message.role === "assistant"
                      ? {
                          ...message,
                          text: options.assistantText ?? message.text,
                        }
                      : message,
                  ),
                  {
                    id: "summary",
                    kind: "turn" as const,
                    threadId: "thread",
                    turnId: "turn",
                    sourceSeqStart: 2,
                    sourceSeqEnd: 4,
                    startedAt: 0,
                    createdAt: 0,
                    completedAt: 1,
                    status: options.status ?? "completed",
                    summaryCount: 0,
                    children: [],
                  },
                ]
              : messages.map((message) =>
                  message.role === "assistant"
                    ? {
                        ...message,
                        text: options.assistantText ?? message.text,
                        turnId: options.turnId ?? "turn",
                      }
                    : message,
                ),
          contextBoundarySeq: options.contextBoundary ?? null,
          completedTurnDisplay: "flat" as const,
          activePromptMode: null,
          activeThinking: null,
          activeWorkflows: [],
          activeBackgroundCommands: [],
          pendingTodos: null,
          extensionStates: {},
          providerCommands: null,
          sessionOptions: null,
          modelFallback: null,
          maxSeq: 4,
          tag: "tag",
          timelinePage: {
            returnedSegmentCount: 1,
            olderCursor: null,
            historySnapshot: "history",
            olderRowsSourceSeqEnd: null,
            olderRowUpdates: [],
          },
        }),
        questions: {
          open: async () => ({
            questions: [],
            total: options.openQuestion ? 1 : 0,
            nextCursor: null,
            readRevision: "q",
          }),
        },
        interactions: {
          list: async () =>
            options.interaction
              ? [
                  {
                    id: "interaction",
                    threadId: "thread",
                    turnId: "turn",
                    providerId: "codex",
                    providerThreadId: "p",
                    providerRequestId: "r",
                    status: "pending" as const,
                    statusReason: null,
                    createdAt: 1,
                    resolvedAt: null,
                    resolution: null,
                    payload:
                      options.interaction === "question"
                        ? { kind: "user_question" as const, questions: [] }
                        : {
                            kind: "approval" as const,
                            subject: {
                              kind: "command" as const,
                              itemId: "cmd",
                              command: "echo ok",
                              cwd: null,
                              actions: [],
                              sessionGrant: null,
                            },
                            reason: null,
                            availableDecisions: [
                              "allow_once" as const,
                              "deny" as const,
                            ],
                          },
                  },
                ]
              : [],
        },
        events: {
          list: async () =>
            options.noHistory
              ? []
              : [
                  {
                    id: "e4",
                    threadId: "thread",
                    seq: 4,
                    createdAt: 1,
                    type: "turn/completed" as const,
                    scope: {
                      kind: "turn" as const,
                      turnId: options.turnId ?? "turn",
                    },
                    data: {
                      providerThreadId: "p",
                      status: options.status ?? "completed",
                    },
                  },
                  {
                    id: "e2",
                    threadId: "thread",
                    seq: 2,
                    createdAt: 0,
                    type: "turn/started" as const,
                    scope: {
                      kind: "turn" as const,
                      turnId: options.turnId ?? "turn",
                    },
                    data: { providerThreadId: "p" },
                  },
                ],
        },
      },
    },
  });
  host.bb.experimental_userInstructions.read = () => ({
    kind: "ready",
    content: "# BIBLE\nPreserve the accepted goal.",
    revision: "fixture-bible",
  });
  return host;
}
