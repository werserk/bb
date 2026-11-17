import { flushSync } from "react-dom";
import type { experimental_ComposerSuggestionController } from "@get-bb/plugin-sdk";

export function acceptComposerSuggestion(
  controller: experimental_ComposerSuggestionController,
): boolean {
  const candidate = controller.getSnapshot().candidate;
  if (candidate === null) return false;
  let accepted = false;
  flushSync(() => {
    accepted = controller.accept(candidate.requestId) === "accepted";
  });
  return accepted;
}

export function handleComposerSuggestionKey(
  event: KeyboardEvent,
  controller: experimental_ComposerSuggestionController,
  blocked: boolean,
  canSubmitWithEnterKey: boolean,
  submit: () => boolean,
): boolean {
  if (blocked || event.isComposing || event.keyCode === 229) return false;
  if (
    (event.key === "Tab" || event.key === "Escape") &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.repeat &&
    controller.experimental_handleContextPreviewKey?.(event.key)
  ) {
    event.preventDefault();
    return true;
  }
  if (event.key === "Escape") {
    controller.dismiss();
    return false;
  }
  if (
    (event.key !== "Tab" &&
      !(event.key === "Enter" && canSubmitWithEnterKey)) ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.repeat
  )
    return false;
  if (controller.getSnapshot().candidate === null) return false;
  const accepted =
    event.key === "Enter" ? submit() : acceptComposerSuggestion(controller);
  if (!accepted) return false;
  event.preventDefault();
  return true;
}
