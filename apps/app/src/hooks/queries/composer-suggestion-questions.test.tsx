// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useComposerSuggestionQuestions } from "./composer-suggestion-questions";
import { invalidateConversationQuestions } from "../cache-owners/conversation-question-cache-owner";
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { questions: { open } } } }));
afterEach(() => {
  cleanup();
  open.mockReset();
});
it("suggestion guard blocks during question invalidation and reads independent durable question revision", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const empty = {
    questions: [],
    total: 0,
    nextCursor: null,
    readRevision: "before",
  };
  open.mockResolvedValueOnce(empty);
  const { result } = renderHook(
    () => useComposerSuggestionQuestions("thread", true),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(result.current?.total).toBe(0));
  let finish: (value: typeof empty) => void = () => {};
  open.mockImplementationOnce(
    () =>
      new Promise<typeof empty>((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void invalidateConversationQuestions({
      queryClient: client,
      threadId: "thread",
    });
  });
  await waitFor(() => expect(result.current).toBeUndefined());
  await act(async () => finish({ ...empty, total: 1, readRevision: "opened" }));
  await waitFor(() => expect(result.current?.readRevision).toBe("opened"));
  expect(result.current?.total).toBe(1);
  expect(open).toHaveBeenLastCalledWith({
    threadId: "thread",
    limit: 1,
    signal: expect.any(AbortSignal),
  });
  client.clear();
});
