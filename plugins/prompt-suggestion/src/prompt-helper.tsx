import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useComposer,
  useRpc,
  type experimental_ComposerSuggestionController,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contracts.js";
import { encodeHelperDraft, decodeHelperDraft } from "./helper-mentions.js";
import type { HelperResponse } from "./helper.js";

function createPanelStore() {
  let state = { open: false, sequence: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(open: boolean) {
      state = { open, sequence: state.sequence + 1 };
      for (const listener of listeners) listener();
    },
  };
}
const panels = new WeakMap<
  experimental_ComposerSuggestionController,
  ReturnType<typeof createPanelStore>
>();
function panelFor(controller: experimental_ComposerSuggestionController) {
  let store = panels.get(controller);
  if (!store) {
    store = createPanelStore();
    panels.set(controller, store);
  }
  return store;
}

export function PromptHelperAction() {
  const composer = useComposer();
  const controller = composer.experimental_suggestions;
  if (!controller?.experimental_suspend) return null;
  return <HelperAction controller={controller} />;
}
function HelperAction({
  controller,
}: {
  controller: experimental_ComposerSuggestionController;
}) {
  const panel = panelFor(controller);
  const state = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot,
  );
  return (
    <button
      type="button"
      aria-label="Prompt helper"
      title="Prompt helper"
      aria-expanded={state.open}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => panel.change(!state.open)}
    >
      <span aria-hidden="true">✦</span>
    </button>
  );
}
export function PromptHelperPanel() {
  const composer = useComposer();
  const controller = composer.experimental_suggestions;
  if (!controller?.experimental_suspend) return null;
  return <HelperPanel controller={controller} />;
}
function HelperPanel({
  controller,
}: {
  controller: experimental_ComposerSuggestionController;
}) {
  const panel = panelFor(controller);
  const state = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot,
  );
  useEffect(() => () => panel.change(false), [panel]);
  useEffect(
    () => (state.open ? controller.experimental_suspend() : undefined),
    [controller, state.open],
  );
  return state.open ? (
    <HelperPreview
      key={state.sequence}
      controller={controller}
      dismiss={() => panel.change(false)}
      retry={() => panel.change(true)}
    />
  ) : null;
}
function composerIdentity(
  controller: experimental_ComposerSuggestionController,
) {
  const snapshot = controller.getSnapshot().snapshot;
  return snapshot
    ? JSON.stringify([snapshot.composerKey, snapshot.threadId])
    : null;
}
function HelperPreview({
  controller,
  dismiss,
  retry,
}: {
  controller: experimental_ComposerSuggestionController;
  dismiss(): void;
  retry(): void;
}) {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [captured] = useState(() => ({
    draft: composer.draft,
    identity: composerIdentity(controller),
    key: composer.key,
  }));
  const currentDraft = composer.draft;
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [result, setResult] = useState<HelperResponse | null>(null);
  const [replacement, setReplacement] =
    useState<ReturnType<typeof decodeHelperDraft>>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const alive = useRef(true);
  const applied = useRef(false);
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const fresh = () =>
    alive.current &&
    composer.key === captured.key &&
    composer.draft === captured.draft &&
    composerIdentity(controller) === captured.identity;
  const stale =
    currentDraft !== captured.draft ||
    composerIdentity(controller) !== captured.identity;
  useEffect(() => {
    alive.current = true;
    let attached = true;
    const requestId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const run = async () => {
      if (!threadId) throw new Error("Open a thread to use Prompt helper.");
      const encoded = encodeHelperDraft(captured.draft, requestId);
      if ([...encoded.text].length > 12000)
        throw new Error(
          "This draft is too long. Prompt helper accepts up to 12,000 characters.",
        );
      const context = await rpc.call("helperContext", { threadId });
      if (!attached) return;
      if (!context.revision)
        throw new Error(
          "Thread context is unavailable. Try again when it is ready.",
        );
      const response = await rpc.call("helper", {
        threadId,
        requestId,
        token,
        draft: encoded.text,
        protectedMentions: encoded.protectedMentions,
        expectedContextRevision: context.revision,
      });
      if (!attached) return;
      setResult(response);
      if (response.kind === "helper") {
        const decoded = decodeHelperDraft(response.text, encoded);
        if (!decoded)
          throw new Error(
            "The result did not preserve your mentions. Try again.",
          );
        setReplacement(decoded);
      } else if (response.kind === "unavailable") {
        throw new Error(
          `Prompt helper is unavailable (${response.reason.replaceAll("_", " ")}). Check the configured model or try again.`,
        );
      }
    };
    void run()
      .catch((cause: unknown) => {
        if (attached)
          setError(
            cause instanceof Error
              ? cause.message
              : "Prompt helper failed. Try again.",
          );
      })
      .finally(() => {
        if (attached) setLoading(false);
      });
    return () => {
      attached = false;
      alive.current = false;
      void rpc.call("cancel", { requestId, token }).catch(() => undefined);
    };
  }, [captured.draft, rpc, threadId]);
  const apply = async () => {
    if (
      !fresh() ||
      !replacement ||
      result?.kind !== "helper" ||
      composer.scope.kind !== "thread"
    )
      return;
    setApplying(true);
    try {
      const context = await rpc.call("helperContext", {
        threadId: composer.scope.threadId,
      });
      if (!fresh()) return;
      if (context.revision !== result.contextRevision) {
        setError(
          "The conversation changed. Try again with the latest context.",
        );
        setReplacement(null);
        return;
      }
      applied.current = false;
      composer.replace((current) => {
        if (!fresh() || current !== captured.draft) return current;
        applied.current = true;
        return replacement;
      });
      if (applied.current) {
        dismiss();
        try {
          composer.focus();
        } catch {
          return;
        }
      }
    } catch {
      if (alive.current)
        setError(
          "The draft could not be updated. Your original draft is preserved.",
        );
    } finally {
      if (alive.current) setApplying(false);
    }
  };
  return (
    <section
      aria-label="Prompt helper preview"
      className="m-2 rounded-lg border border-border bg-muted/30 p-3 text-sm"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong>
          {captured.draft.text.trim() ? "Improved request" : "Next step"}
        </strong>
        <button
          type="button"
          onClick={dismiss}
          className="rounded px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
      {loading ? (
        <p role="status" className="text-muted-foreground">
          Preparing a proposal…
        </p>
      ) : null}
      {replacement ? (
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
          {replacement.text}
        </p>
      ) : null}
      {result?.kind === "helper" && result.advice ? (
        <div className="mt-3 border-t border-border pt-2">
          <strong>Advice</strong>
          <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {result.advice}
          </p>
        </div>
      ) : null}
      {result?.kind === "none" ? (
        <p className="text-muted-foreground">
          No useful next step is supported by the current conversation.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
      {stale ? (
        <p role="status" className="mt-2 text-muted-foreground">
          Your draft or composer changed. Try again to update this proposal.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={loading || applying || stale || !replacement}
          onClick={() => void apply()}
          className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
        >
          {applying
            ? "Checking…"
            : captured.draft.text.trim()
              ? "Replace draft"
              : "Insert"}
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={retry}
          className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
        >
          Try again
        </button>
      </div>
    </section>
  );
}
