// @vitest-environment jsdom
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationMessageContent } from "./ConversationMessageContent";
vi.mock("../user-questions/ConversationQuestionCard", () => ({
  ConversationQuestionCard: ({
    questionId,
    threadId,
  }: {
    questionId: string;
    threadId: string;
  }) => (
    <div>
      {threadId}:{questionId}
    </div>
  ),
}));
afterEach(cleanup);
it("renders a scoped durable question at the exact assistant message position", () => {
  render(
    <ConversationMessageContent
      role="assistant"
      attachments={null}
      id="question:qst_23456789ab"
      threadId="thr_test"
      turnId="turn"
      showActions={false}
      mobileActionDisplay="overflow"
      streaming={false}
      timestamp={0}
      text={'::question{id="qst_23456789ab"}'}
    />,
  );
  expect(screen.getByText("thr_test:qst_23456789ab")).toBeTruthy();
});
