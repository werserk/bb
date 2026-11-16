import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useComposer,
  useRpc,
  useSettings,
  type experimental_ComposerSuggestionController,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./src/contracts.js";

function SuggestionController() {
  const composer = useComposer();
  const controller = composer.experimental_suggestions;
  if (!controller) return null;
  return <ConnectedSuggestionController controller={controller} />;
}

function ConnectedSuggestionController({
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
  useEffect(
    () =>
      controller.onEvent((event) => {
        if (event.requestId)
          void rpc
            .call("observe", { requestId: event.requestId, event: event.kind })
            .catch(() => undefined);
      }),
    [controller, rpc],
  );
  const configuration = JSON.stringify(settings.values);
  useEffect(() => {
    if (!state.eligible || !snapshot || settings.values?.enabled !== true)
      return;
    const requestId = crypto.randomUUID();
    const token = crypto.randomUUID();
    let cancelled = false;
    void rpc
      .call("suggest", {
        threadId: snapshot.threadId,
        requestId,
        token,
        automatic: true,
        expectedTurnId: snapshot.completedTurnId,
      })
      .then((result) => {
        if (!cancelled && result.kind === "suggestion")
          controller.show({ requestId, snapshot, text: result.text });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.clear(requestId);
      void rpc.call("cancel", { requestId, token }).catch(() => undefined);
    };
  }, [
    controller,
    rpc,
    state.eligible,
    snapshot,
    settings.values?.enabled,
    configuration,
  ]);
  return null;
}
export default definePluginApp((app) => {
  app.composer.customize({
    id: "autosay",
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
