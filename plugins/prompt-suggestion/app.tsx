import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  useComposer,
  useRpc,
  useSettings,
  type experimental_ComposerSuggestionController,
} from "@get-bb/plugin-sdk/app";
import { ModelSettings } from "./src/model-settings.js";
import { rpcContract } from "./src/contracts.js";

function SuggestionController() {
  const composer = useComposer();
  const controller = composer.experimental_suggestions;
  if (!controller) return null;
  return <ConnectedSuggestionController controller={controller} />;
}

export function ConnectedSuggestionController({
  controller,
}: {
  controller: experimental_ComposerSuggestionController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const snapshot = state.snapshot;
  const threadId = snapshot?.threadId ?? "";
  const configuration = JSON.stringify(settings.values);
  const registration = `${threadId}:${configuration}`;
  const [foreground, setForeground] = useState(
    () => document.visibilityState !== "hidden" && document.hasFocus(),
  );
  const [registered, setRegistered] = useState<string | null>(null);
  const membership = useRef<{
    threadId: string;
    clientId: string;
    turnId: string | null;
  } | null>(null);
  const handled = useRef(new Set<string>());
  const attached = useRef<string | null>(null);
  const readyObservation = useRef<{ jobId: string; at: number } | null>(null);
  const enabled = !!threadId && foreground && settings.values?.enabled === true;
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "state",
    input: { threadId },
    enabled,
  });
  const refetch = useRef(query.refetch);
  useEffect(() => {
    refetch.current = query.refetch;
  }, [query.refetch]);
  useEffect(() => {
    const visibility = () =>
      setForeground(
        document.visibilityState !== "hidden" && document.hasFocus(),
      );
    const focus = () => setForeground(document.visibilityState !== "hidden");
    const blur = () => setForeground(false);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(
    () =>
      controller.onEvent((event) => {
        if (
          event.kind === "dismissed" &&
          event.experimental_cause !== undefined &&
          event.experimental_cause !== "user"
        )
          return;
        const requestId = event.requestId ?? attached.current;
        if (requestId) {
          if (event.kind !== "shown") handled.current.add(requestId);
          void rpc
            .call("observe", {
              requestId,
              event: event.kind,
              observedToAttachMs:
                event.kind === "shown" &&
                readyObservation.current?.jobId === requestId
                  ? Math.max(0, performance.now() - readyObservation.current.at)
                  : null,
            })
            .catch(() => undefined);
        }
      }),
    [controller, rpc, threadId],
  );
  useEffect(() => {
    if (!enabled) return;
    const clientId = crypto.randomUUID();
    const lifetime = new AbortController();
    const current = {
      threadId,
      clientId,
      turnId: controller.getSnapshot().snapshot?.completedTurnId ?? null,
    };
    membership.current = current;
    void rpc
      .call("track", { threadId, clientId })
      .then(async () => {
        if (lifetime.signal.aborted) {
          await rpc.call("detach", { threadId, clientId });
          return;
        }
        await refetch.current();
        if (!lifetime.signal.aborted) setRegistered(registration);
      })
      .catch(() => undefined);
    return () => {
      lifetime.abort();
      if (membership.current === current) membership.current = null;
      setRegistered(null);
      if (attached.current) controller.clear(attached.current);
      attached.current = null;
      void rpc.call("detach", { threadId, clientId }).catch(() => undefined);
    };
  }, [controller, rpc, threadId, enabled, registration]);
  useEffect(() => {
    const current = membership.current;
    const turnId = snapshot?.completedTurnId ?? null;
    if (
      !enabled ||
      !current ||
      current.threadId !== threadId ||
      current.turnId === turnId
    )
      return;
    current.turnId = turnId;
    void rpc
      .call("track", { threadId, clientId: current.clientId })
      .catch(() => undefined);
  }, [rpc, threadId, enabled, snapshot?.completedTurnId]);
  useEffect(() => {
    const view = query.data;
    if (
      !enabled ||
      registered !== registration ||
      !state.eligible ||
      !snapshot ||
      !view ||
      query.error
    ) {
      if (attached.current) controller.clear(attached.current);
      return;
    }
    if (!view.jobId || view.turnId !== snapshot.completedTurnId) {
      if (attached.current) controller.clear(attached.current);
      return;
    }
    if (handled.current.has(view.jobId)) return;
    const requestId = view.jobId;
    if (view.phase === "queued" || view.phase === "pending") {
      if (controller.getSnapshot().request?.requestId !== requestId) {
        attached.current = requestId;
        controller.experimental_begin(requestId, snapshot);
      }
    } else if (view.phase === "ready" && view.result?.kind === "suggestion") {
      if (controller.getSnapshot().candidate?.requestId === requestId) return;
      readyObservation.current = { jobId: requestId, at: performance.now() };
      attached.current = requestId;
      if (controller.experimental_begin(requestId, snapshot))
        controller.show({ requestId, snapshot, text: view.result.text });
    } else {
      handled.current.add(requestId);
      attached.current = requestId;
      if (controller.experimental_begin(requestId, snapshot))
        controller.experimental_finish(
          requestId,
          snapshot,
          view.phase === "error" && view.result?.kind === "unavailable"
            ? view.result.reason === "timeout"
              ? "timeout"
              : view.result.reason === "generation_failed" ||
                  view.result.reason === "output_truncated"
                ? "failed"
                : null
            : null,
        );
    }
  }, [
    controller,
    enabled,
    registered,
    registration,
    state.eligible,
    snapshot,
    query.data,
    query.error,
  ]);
  return null;
}
export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "generator", component: ModelSettings });
  app.composer.customize({
    id: "prompt-suggestion",
    scopes: ["thread"],
    banners: [
      {
        id: "suggestion-controller",
        chrome: "bare",
        component: SuggestionController,
      },
    ],
  });
});
