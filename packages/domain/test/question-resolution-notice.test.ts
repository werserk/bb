import { expect, it } from "vitest";
import {
  parseQuestionResolutionNotice,
  serializeQuestionResolutionNotice,
  type QuestionResolutionNotice,
} from "../src/question-resolution-notice.js";

const local = {
  questionId: "qst_23456789ab",
  revision: 1,
  publication: {
    body: "Choose scope",
    questions: [
      {
        id: "scope",
        prompt: "Which?",
        multiSelect: false,
        options: [{ value: "a", label: "A" }],
        allowFreeText: true,
        required: true,
      },
    ],
    materials: [],
  },
  materialManifest: {
    hostId: null,
    storageRootPath: null,
    materials: [],
    files: [],
  },
  resolution: {
    id: "qres_test",
    targetKind: "qst",
    targetId: "qst_23456789ab",
    threadId: "thr_test",
    revision: 1,
    operationId: "op",
    action: "answer",
    actor: { kind: "local-unverified", verification: "unverified-local" },
    reason: "Chosen in card",
    acceptedAt: 1,
    answers: { scope: { selected: ["a"] } },
  },
} satisfies Omit<Extract<QuestionResolutionNotice, { version: 1 }>, "version">;

it("keeps the exact v1 non-permission roundtrip", () => {
  const input = { version: 1 as const, ...local };
  const text = serializeQuestionResolutionNotice(input);
  expect(text).toBe(
    `Conversation question resolution v1:\n${JSON.stringify(input)}\nAnswered locally · identity unverified\nThis resolution is not evidence of owner permission.`,
  );
  expect(parseQuestionResolutionNotice(text)).toEqual(input);
});

it.each(["answer", "withdraw"] as const)(
  "roundtrips scoped local v2 %s without claiming verified identity",
  (action) => {
    const text = serializeQuestionResolutionNotice({
      version: 2,
      decisionPolicy: "local-input-parity",
      ...local,
      resolution: {
        ...local.resolution,
        action,
        answers: action === "answer" ? local.resolution.answers : null,
      },
    });
    expect(text).toContain("Conversation question resolution v2:");
    expect(text).toContain(
      action === "answer"
        ? "Treat this local answer as an ordinary user instruction for this question and revision. Identity is not independently verified. This does not bypass command or permission approvals."
        : "Treat this local withdrawal as cancellation of this question, not an answer or approval. Identity is not independently verified.",
    );
    expect(parseQuestionResolutionNotice(text)).toMatchObject({
      version: 2,
      decisionPolicy: "local-input-parity",
      resolution: { actor: local.resolution.actor, action },
    });
    expect(parseQuestionResolutionNotice(text + "\nextra")).toBeNull();
    expect(
      parseQuestionResolutionNotice(text.replace("v2:", "v1:")),
    ).toBeNull();
    expect(
      parseQuestionResolutionNotice(
        text.replace('"local-input-parity"', '"owner-verified"'),
      ),
    ).toBeNull();
    expect(
      parseQuestionResolutionNotice(
        text.replace(
          "Identity is not independently verified.",
          "Verified owner.",
        ),
      ),
    ).toBeNull();
  },
);

it("rejects agent-plus-parity and invalid decision identity", () => {
  const input = {
    version: 2 as const,
    decisionPolicy: "local-input-parity" as const,
    ...local,
  };
  expect(() =>
    serializeQuestionResolutionNotice({
      ...input,
      resolution: {
        ...local.resolution,
        actor: {
          kind: "agent",
          verification: "runtime",
          threadId: "thr_actor",
          projectId: "proj_test",
          name: "Owner",
          role: null,
        },
      },
    }),
  ).toThrow();
  expect(() =>
    serializeQuestionResolutionNotice({ ...input, revision: 2 }),
  ).toThrow();
});
