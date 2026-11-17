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
  const suspensions = new Set<symbol>();
  let latestRequestId: string | null = null;
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
    request: null,
  });
  const listeners = new Set<() => void>();
  const events = new Set<
    (event: experimental_ComposerSuggestionEvent) => void
  >();
  const emit = (
    kind: experimental_ComposerSuggestionEvent["kind"],
    requestId: string | null,
    experimental_cause: "user" | "context" | "programmatic",
  ) => {
    for (const listener of [...events])
      listener({ kind, requestId, experimental_cause });
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
  const invalidate = (cause: "user" | "context" | "programmatic" | null) => {
    revision++;
    latestRequestId = null;
    const old = state.candidate;
    publish({
      eligible: input.eligible && suspensions.size === 0,
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
      request: null,
    });
    if (cause) emit("dismissed", old?.requestId ?? null, cause);
  };
  const controller: experimental_ComposerSuggestionController = {
    experimental_suspend() {
      const token = Symbol();
      suspensions.add(token);
      latestRequestId = null;
      const old = state.candidate;
      publish({ ...state, eligible: false, candidate: null, request: null });
      if (old) emit("dismissed", old.requestId, "programmatic");
      return () => {
        if (!suspensions.delete(token)) return;
        publish({
          ...state,
          eligible: input.eligible && suspensions.size === 0,
        });
      };
    },
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
    experimental_begin(requestId, snapshot) {
      if (!requestId || !state.eligible || !canUse() || !matches(snapshot))
        return false;
      latestRequestId = requestId;
      publish({
        ...state,
        candidate: null,
        request: Object.freeze({
          requestId,
          snapshot,
          phase: "pending",
          error: null,
        }),
      });
      return true;
    },
    experimental_finish(requestId, snapshot, error) {
      if (
        state.request?.requestId !== requestId ||
        !matches(snapshot) ||
        !state.eligible ||
        !canUse()
      )
        return false;
      publish({
        ...state,
        request:
          error === null
            ? null
            : Object.freeze({ requestId, snapshot, phase: "error", error }),
      });
      return true;
    },
    show(value) {
      const parsed = candidateSchema.safeParse(value);
      if (!parsed.success) return false;
      const candidate = parsed.data;
      if (
        !state.eligible ||
        !canUse() ||
        !matches(candidate.snapshot) ||
        (latestRequestId !== null &&
          (latestRequestId !== candidate.requestId ||
            state.request?.phase !== "pending"))
      )
        return false;
      publish({
        ...state,
        request: null,
        candidate: Object.freeze({
          ...candidate,
          snapshot: Object.freeze({ ...candidate.snapshot }),
        }),
      });
      emit("shown", candidate.requestId, "programmatic");
      return true;
    },
    clear(requestId) {
      if (state.candidate?.requestId === requestId) invalidate("programmatic");
      else if (state.request?.requestId === requestId)
        publish({ ...state, request: null });
    },
    dismiss: () => invalidate("user"),
    accept(requestId) {
      if (!state.eligible || !canUse()) return "ineligible";
      const candidate = state.candidate;
      if (candidate?.requestId !== requestId || !matches(candidate.snapshot))
        return "stale";
      invalidate(null);
      replace(candidate.text);
      emit("accepted", requestId, "user");
      return "accepted";
    },
  };
  return {
    controller,
    update(next: ComposerSuggestionInput) {
      if (JSON.stringify(input) === JSON.stringify(next)) return;
      input = next;
      invalidate("context");
    },
    draftChanged: () => invalidate("user"),
    dispose() {
      input = { ...input, eligible: false, threadId: null };
      invalidate("context");
    },
  };
}
