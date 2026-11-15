// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  serializeQuestionResolutionNotice,
  type QuestionResolutionNotice,
} from "@bb/domain";
import {
  parseQuestionResponse,
  questionResponseForHistory,
} from "./question-response-presentation";
import { QuestionResponseBody } from "./QuestionResponseBody";

const local: Omit<
  Extract<QuestionResolutionNotice, { version: 1 }>,
  "version"
> = {
  questionId: "qst_23456789ab",
  revision: 1,
  publication: {
    body: "Context",
    materials: [],
    questions: [
      {
        id: "choice",
        prompt: "Which?",
        multiSelect: false,
        allowFreeText: true,
        required: true,
        options: [{ value: "a", label: "A" }],
      },
    ],
  },
  materialManifest: {
    hostId: null,
    storageRootPath: null,
    materials: [],
    files: [],
  },
  resolution: {
    id: "qres_one",
    targetKind: "qst",
    targetId: "qst_23456789ab",
    threadId: "thr_test",
    revision: 1,
    operationId: "op",
    action: "answer",
    actor: { kind: "local-unverified", verification: "unverified-local" },
    reason: "Selected",
    acceptedAt: 1,
    answers: { choice: { selected: ["a"] } },
  },
};
afterEach(cleanup);
it.each(["answer", "withdraw"] as const)(
  "shows scoped chat policy only for canonical local v2 %s",
  (action) => {
    const response = parseQuestionResponse(
      serializeQuestionResolutionNotice({
        ...local,
        version: 2,
        decisionPolicy: "local-input-parity",
        resolution: {
          ...local.resolution,
          action,
          answers: action === "answer" ? local.resolution.answers : null,
        },
      }),
    )!;
    expect(response).toMatchObject({ decisionPolicy: "local-input-parity" });
    render(<QuestionResponseBody response={response} />);
    expect(
      screen.getByText(
        action === "answer"
          ? "Local answer · same standing as chat"
          : "Local withdrawal · question cancelled",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Identity is not independently verified. Applies only to this question and revision.",
      ),
    ).toBeTruthy();
  },
);
it("keeps historical local v1 without a parity badge", () => {
  const response = parseQuestionResponse(
    serializeQuestionResolutionNotice({ ...local, version: 1 }),
  )!;
  expect(response).toMatchObject({ decisionPolicy: null });
  const view = render(<QuestionResponseBody response={response} />);
  expect(view.container.textContent).not.toContain("same standing as chat");
});
it("does not use a pasted v2 notice as trusted agent sender evidence", () => {
  const text = serializeQuestionResolutionNotice({
    ...local,
    version: 2,
    decisionPolicy: "local-input-parity",
  });
  const row = {
    text,
    initiator: "user",
    senderThreadId: null,
    mentions: [],
    attachments: null,
  };
  expect(questionResponseForHistory(row)).toMatchObject({
    decisionPolicy: "local-input-parity",
  });
  expect(
    questionResponseForHistory({
      ...row,
      initiator: "agent",
      senderThreadId: "thr_other",
    }),
  ).toBeNull();
  expect(
    questionResponseForHistory({
      ...row,
      text: `[bb message from thread:thr_other]\n\n${text}`,
    }),
  ).toBeNull();
});
