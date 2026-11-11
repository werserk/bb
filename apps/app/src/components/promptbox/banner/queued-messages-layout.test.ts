import { describe, expect, it } from "vitest";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import { getQueuedMessagesDrawerHeight } from "./queued-messages-layout";

describe("queued message content height", () => {
  const queuedMessages = [makeThreadQueuedMessage()];

  it("fits measured content, including wrapped answers, up to the drawer cap", () => {
    const height = (contentHeight: number) =>
      getQueuedMessagesDrawerHeight({
        queuedMessages,
        processingMessageId: null,
        contentHeight,
      });
    expect(height(60)).toBe(125);
    expect(height(180)).toBe(198);
    expect(height(40)).toBe(105);
  });

  it("keeps the row estimate before content can be measured", () => {
    const input = { queuedMessages, processingMessageId: null };
    expect(getQueuedMessagesDrawerHeight({ ...input, contentHeight: 0 })).toBe(
      getQueuedMessagesDrawerHeight(input),
    );
  });
});
