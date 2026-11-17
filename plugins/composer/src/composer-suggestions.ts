import type {
  experimental_ComposerSuggestionController,
  experimental_ComposerSuggestionState,
} from "@get-bb/plugin-sdk";

const unavailableState: experimental_ComposerSuggestionState = Object.freeze({
  eligible: false,
  snapshot: null,
  candidate: null,
  request: null,
});

const unavailableSuggestions: experimental_ComposerSuggestionController = {
  getSnapshot: () => unavailableState,
  subscribe: () => () => {},
  experimental_begin: () => false,
  experimental_finish: () => false,
  show: () => false,
  clear: () => {},
  dismiss: () => {},
  accept: () => "ineligible",
  onEvent: () => () => {},
};

export function resolveComposerSuggestions(
  controller: experimental_ComposerSuggestionController | undefined,
): experimental_ComposerSuggestionController {
  return controller ?? unavailableSuggestions;
}
