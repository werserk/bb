import type { experimental_ComposerSuggestionController } from "@get-bb/plugin-sdk";
import { useSyncExternalStore } from "react";

export function ComposerSuggestion({
  controller,
}: {
  controller: experimental_ComposerSuggestionController;
}) {
  const { candidate } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (candidate === null) return null;
  return (
    <div
      className="px-4 py-2 text-muted-foreground"
      aria-label="Suggested message"
    >
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
        {candidate.text}
      </div>
      <button
        type="button"
        className="text-sm underline"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => controller.accept(candidate.requestId)}
      >
        Use suggestion <kbd>Tab</kbd>
      </button>
    </div>
  );
}
