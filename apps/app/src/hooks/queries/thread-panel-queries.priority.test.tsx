// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPriority } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadConversationOutline } from "./thread-panel-queries";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { conversationOutline: vi.fn() } },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("conversation outline fetch priority", () => {
  it("tags the outline request as low so it yields to the target thread", async () => {
    vi.mocked(sdk.threads.conversationOutline).mockResolvedValue({
      entries: [],
    } as never);
    const harness = createQueryClientTestHarness();
    renderHook(() => useThreadConversationOutline("thread-1", "user"), {
      wrapper: harness.wrapper,
    });
    await waitFor(() =>
      expect(sdk.threads.conversationOutline).toHaveBeenCalledTimes(1),
    );
    const signal = vi.mocked(sdk.threads.conversationOutline).mock.calls[0]?.[0]
      .signal;
    expect(requestPriority({ signal })).toBe("low");
  });
});
