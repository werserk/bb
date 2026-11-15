import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import { getQueuedMessagesDrawerHeight } from "@/components/promptbox/banner/queued-messages-layout";

const tenRows = Array.from({ length: 10 }, (_, index) =>
  makeThreadQueuedMessage({ id: `q_${index}`, waitingOn: null }),
);

describe("getQueuedMessagesDrawerHeight", () => {
  it.each([
    { windowHeight: 600, height: 198 },
    { windowHeight: 1000, height: 300 },
    { windowHeight: 2000, height: 360 },
  ])(
    "lets a long queue use 30% of a $windowHeight px window, within 198-360 px",
    ({ windowHeight, height }) => {
      expect(
        getQueuedMessagesDrawerHeight({
          queuedMessages: tenRows,
          processingMessageId: null,
          windowHeight,
        }),
      ).toBe(height);
    },
  );

  it("fits a short queue exactly instead of filling the cap", () => {
    expect(
      getQueuedMessagesDrawerHeight({
        queuedMessages: tenRows.slice(0, 2),
        processingMessageId: null,
        windowHeight: 2000,
      }),
    ).toBe(135);
  });
});

describe("queued message content height", () => {
  const queuedMessages = [makeThreadQueuedMessage()];

  it("fits measured content, including wrapped answers, up to the drawer cap", () => {
    const height = (contentHeight: number) =>
      getQueuedMessagesDrawerHeight({
        queuedMessages,
        processingMessageId: null,
        contentHeight,
        windowHeight: 600,
      });
    expect(height(60)).toBe(125);
    expect(height(180)).toBe(198);
    expect(height(40)).toBe(105);
  });

  it("keeps the row estimate before content can be measured", () => {
    const input = { queuedMessages, processingMessageId: null, windowHeight: 600 };
    expect(getQueuedMessagesDrawerHeight({ ...input, contentHeight: 0 })).toBe(
      getQueuedMessagesDrawerHeight(input),
    );
  });
});
