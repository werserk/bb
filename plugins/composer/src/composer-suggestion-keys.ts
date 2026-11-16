import type { experimental_ComposerSuggestionController } from "@get-bb/plugin-sdk";

export function handleComposerSuggestionKey(
  event: KeyboardEvent,
  controller: experimental_ComposerSuggestionController,
  blocked: boolean,
): boolean {
  if (blocked || event.isComposing || event.keyCode === 229) return false;
  if (event.key === "Escape") {
    controller.dismiss();
    return false;
  }
  if (
    event.key !== "Tab" ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.repeat
  )
    return false;
  const candidate = controller.getSnapshot().candidate;
  if (
    candidate === null ||
    controller.accept(candidate.requestId) !== "accepted"
  )
    return false;
  event.preventDefault();
  return true;
}
