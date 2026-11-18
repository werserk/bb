// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useQueuedMessageActions } from "./useQueuedMessageActions";

const state = vi.hoisted(() => ({
  mutations: Array.from({ length: 5 }, () => ({
    isPending: false,
    variables: undefined as { id: string } | undefined,
    mutateAsync: vi.fn(),
  })),
}));
vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useDeleteThreadQueuedMessage: () => state.mutations[0],
  useReorderThreadQueuedMessage: () => state.mutations[1],
  useSetThreadQueuedMessageGroupBoundary: () => state.mutations[2],
  useSendThreadQueuedMessage: () => state.mutations[3],
  useUpdateThreadQueuedMessage: () => state.mutations[4],
}));
afterEach(() => {
  for (const mutation of state.mutations) {
    mutation.isPending = false;
    mutation.variables = undefined;
  }
});
it.each([0, 1, 2, 3, 4])(
  "scopes pending queue action %i to its thread after navigation",
  (index) => {
    state.mutations[index]!.isPending = true;
    state.mutations[index]!.variables = { id: "thr_a" };
    const { result, rerender } = renderHook(
      ({ threadId }) =>
        useQueuedMessageActions({
          threadId,
          queuedMessages: [],
          sendProcessingPersistence: "until-left-queue",
          inlineEditingQueuedMessage: null,
          dismissInlineQueuedMessageEditor: vi.fn(),
          activeComposerDraftInput: [],
        }),
      { initialProps: { threadId: "thr_a" } },
    );
    expect(result.current.queuedMessageActionPending).toBe(true);
    expect(result.current.isUpdateQueuedMessagePending).toBe(index === 4);
    act(() => rerender({ threadId: "thr_b" }));
    expect(result.current.queuedMessageActionPending).toBe(false);
    expect(result.current.isUpdateQueuedMessagePending).toBe(false);
  },
);

it.each(["saved", "removed"] as const)(
  "does not dismiss B's editor when A's pending save is %s",
  async (outcome) => {
    const { createDeferredPromise } = await import("@bb/test-helpers");
    const { makeThreadQueuedMessage } =
      await import("@bb/test-helpers/domain-fixtures");
    const { BbHttpError } = await import("@/lib/sdk");
    const pending = createDeferredPromise<void>();
    state.mutations[4]!.mutateAsync.mockReturnValueOnce(pending.promise);
    const dismiss = vi.fn(),
      saved = vi.fn();
    const { result, rerender } = renderHook(
      ({ threadId, editSessionId }) =>
        useQueuedMessageActions({
          threadId,
          queuedMessages: [
            makeThreadQueuedMessage({ id: `q-${threadId}`, threadId }),
          ],
          sendProcessingPersistence: "until-left-queue",
          inlineEditingQueuedMessage: {
            draft: { text: "edit", mentions: [], attachments: [] },
            editSessionId,
            expectedUpdatedAt: 1,
            model: "gpt-5",
            ownerThreadId: threadId,
            permissionMode: "accept-edits",
            queuedMessageId: `q-${threadId}`,
            queuedMessageIndex: 0,
            reasoningLevel: "medium",
            serviceTier: "default",
          },
          dismissInlineQueuedMessageEditor: dismiss,
          onSaveSuccess: saved,
          activeComposerDraftInput: [
            { type: "text", text: "edit", mentions: [] },
          ],
        }),
      { initialProps: { threadId: "thr_a", editSessionId: 1 } },
    );
    let save!: Promise<void>;
    act(() => {
      save = result.current.handleSaveInlineQueuedMessage();
    });
    rerender({ threadId: "thr_b", editSessionId: 2 });
    await act(async () => {
      if (outcome === "saved") pending.resolve();
      else
        pending.reject(
          new BbHttpError({
            status: 404,
            code: "not_found",
            message: "removed",
            body: { message: "removed" },
          }),
        );
      await save;
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  },
);
