import { z } from "zod";
import type {
  experimental_ComposerSuggestionController,
  experimental_ComposerSuggestionEvent,
  experimental_ComposerSuggestionSnapshot,
  experimental_ComposerSuggestionState,
} from "../app-contract.js";

const candidateSchema = z.object({
  requestId: z.string().min(1),
  text: z
    .string()
    .refine((value) => value.trim().length > 0 && [...value].length <= 600),
  snapshot: z.object({
    composerKey: z.string(),
    threadId: z.string(),
    completedTurnId: z.string(),
    contextRevision: z.string(),
    draftRevision: z.number().int().nonnegative(),
  }),
});

export interface ComposerSuggestionInput {
  composerKey: string;
  threadId: string | null;
  contextRevision: string;
  completedTurnId: string;
  eligible: boolean;
}

export function createComposerSuggestionController(
  replace: (text: string) => void,
  canUse: () => boolean = () => true,
) {
  let revision = 0;
  let input: ComposerSuggestionInput = {
    composerKey: "",
    threadId: null,
    contextRevision: "",
    completedTurnId: "",
    eligible: false,
  };
  let state: experimental_ComposerSuggestionState = Object.freeze({
    eligible: false,
    snapshot: null,
    candidate: null,
  });
  const listeners = new Set<() => void>();
  const events = new Set<
    (event: experimental_ComposerSuggestionEvent) => void
  >();
  const emit = (
    kind: experimental_ComposerSuggestionEvent["kind"],
    requestId: string | null,
  ) => {
    for (const listener of [...events]) listener({ kind, requestId });
  };
  const publish = (next: experimental_ComposerSuggestionState) => {
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const matches = (snapshot: experimental_ComposerSuggestionSnapshot) => {
    const current = state.snapshot;
    return (
      current !== null &&
      current.composerKey === snapshot.composerKey &&
      current.threadId === snapshot.threadId &&
      current.completedTurnId === snapshot.completedTurnId &&
      current.contextRevision === snapshot.contextRevision &&
      current.draftRevision === snapshot.draftRevision
    );
  };
  const invalidate = (dismissed = true) => {
    revision++;
    const old = state.candidate;
    publish({
      eligible: input.eligible,
      snapshot:
        input.threadId === null
          ? null
          : Object.freeze({
              composerKey: input.composerKey,
              threadId: input.threadId,
              completedTurnId: input.completedTurnId,
              contextRevision: input.contextRevision,
              draftRevision: revision,
            }),
      candidate: null,
    });
    if (dismissed) emit("dismissed", old?.requestId ?? null);
  };
  const controller: experimental_ComposerSuggestionController = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEvent(listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    show(value) {
      const parsed = candidateSchema.safeParse(value);
      if (!parsed.success) return false;
      const candidate = parsed.data;
      if (!state.eligible || !canUse() || !matches(candidate.snapshot))
        return false;
      publish({
        ...state,
        candidate: Object.freeze({
          ...candidate,
          snapshot: Object.freeze({ ...candidate.snapshot }),
        }),
      });
      emit("shown", candidate.requestId);
      return true;
    },
    clear(requestId) {
      if (state.candidate?.requestId === requestId) invalidate();
    },
    dismiss: () => invalidate(),
    accept(requestId) {
      if (!state.eligible || !canUse()) return "ineligible";
      const candidate = state.candidate;
      if (candidate?.requestId !== requestId || !matches(candidate.snapshot))
        return "stale";
      invalidate(false);
      replace(candidate.text);
      emit("accepted", requestId);
      return "accepted";
    },
  };
  return {
    controller,
    update(next: ComposerSuggestionInput) {
      if (JSON.stringify(input) === JSON.stringify(next)) return;
      input = next;
      invalidate();
    },
    draftChanged: () => invalidate(),
    dispose() {
      input = { ...input, eligible: false, threadId: null };
      invalidate();
    },
  };
}
