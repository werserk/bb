import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_ComposerContextStrip as ComposerContextStrip,
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
      title="New suggestion · Tab accepts"
      aria-expanded={state.open}
      onMouseDown={(event) => event.preventDefault()}
      className="flex h-full w-5 shrink-0 items-center justify-center rounded text-[0.85em] leading-none text-subtle-foreground transition-colors hover:text-foreground aria-expanded:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
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
      const response = await rpc.call("helper", {
        threadId,
        requestId,
        token,
        draft: encoded.text,
        protectedMentions: encoded.protectedMentions,
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
        throw new Error(helperReason(response.reason));
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
      if (!fresh()) return;
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
  const ready = !loading && !applying && !stale && replacement !== null;
  return (
    <ComposerContextStrip
      onAccept={ready ? () => void apply() : undefined}
      onDismiss={dismiss}
    >
      <section
        aria-label="Prompt helper preview"
        className="flex min-w-0 items-start gap-2 text-sm"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span
          title={
            result?.kind === "helper" && result.advice
              ? result.advice
              : "Prompt helper"
          }
          className="shrink-0 text-muted-foreground"
          aria-label={
            result?.kind === "helper" && result.advice
              ? result.advice
              : "Prompt helper advice"
          }
        >
          ✦
        </span>
        <div className="min-w-0 flex-1">
          {loading ? <span role="status">Preparing a proposal…</span> : null}
          {replacement && !stale && !error ? (
            <span data-prompt-helper-text="" className="block truncate">
              {replacement.text}
            </span>
          ) : null}
          {result?.kind === "none" ? (
            <span>
              No useful next step is supported by the current conversation.
            </span>
          ) : null}
          {stale ? (
            <span role="status">Your draft moved on. </span>
          ) : error ? (
            <span role="alert">{error} </span>
          ) : null}
          {!loading && (stale || error || result?.kind === "none") ? (
            <button
              type="button"
              className="underline"
              onClick={(event) => {
                event.stopPropagation();
                retry();
              }}
            >
              Refresh
            </button>
          ) : null}
        </div>
        {ready ? (
          <button
            type="button"
            aria-label="Replace draft"
            title="Replace draft · Tab"
            className="shrink-0 text-xs text-muted-foreground"
            onClick={(event) => {
              event.stopPropagation();
              void apply();
            }}
          >
            Tab
          </button>
        ) : null}
      </section>
    </ComposerContextStrip>
  );
}

function helperReason(reason: string) {
  switch (reason) {
    case "stale":
      return "The conversation moved on while preparing. Refresh?";
    case "timeout":
      return "Preparing the proposal timed out. Try again.";
    case "busy":
      return "Prompt helper is busy. Try again shortly.";
    case "not_configured":
      return "Choose a model in Prompt Suggestion settings to use Prompt helper.";
    case "cancelled":
      return "Preparing the proposal was cancelled.";
    case "rate_limited":
      return "Prompt helper reached its request limit. Try again later.";
    case "ineligible":
      return "Thread context is unavailable. Try again when it is ready.";
    case "invalid_mentions":
      return "The proposal could not preserve your mentions. Try again.";
    case "output_truncated":
      return "The proposal was cut short. Try again.";
    case "invalid_input":
      return "This draft could not be prepared. Check its length and mentions.";
    case "duplicate_request":
      return "This proposal is already being prepared.";
    default:
      return `Prompt helper failed (${reason.replaceAll("_", " ")}). Try again.`;
  }
}
