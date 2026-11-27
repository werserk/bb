// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createComposerSuggestionController } from "@get-bb/plugin-sdk/internal/composer-handle";
import { handleComposerSuggestionKey } from "../../../../../../plugins/composer/src/composer-suggestion-keys";
import {
  ComposerContextProvider,
  ComposerContextSources,
  ComposerContextItem,
  useComposerContextStore,
} from "./composer-context";
import { ComposerContextDock } from "./ComposerContextDock";
import { ComposerContextStrip } from "./ComposerContextStrip";

afterEach(cleanup);

function Editor() {
  const store = useComposerContextStore();
  const [suggestions] = useState(
    () =>
      createComposerSuggestionController(
        () => {},
        () => true,
        (key) => store?.previewKey(key) ?? false,
      ).controller,
  );
  return (
    <textarea
      aria-label="Draft"
      onKeyDown={(event) =>
        handleComposerSuggestionKey(
          event.nativeEvent,
          suggestions,
          false,
          true,
          () => false,
        )
      }
    />
  );
}

it("Escape in the editor closes a chip section and keeps the visible preview", () => {
  const dismiss = vi.fn();
  render(
    <ComposerContextProvider>
      <ComposerContextSources>
        <ComposerContextItem
          id="plan"
          label="Plan"
          icon="ListTodo"
          group="work"
          kind="plan"
        >
          <p>Plan body</p>
        </ComposerContextItem>
      </ComposerContextSources>
      <ComposerContextDock>
        <ComposerContextStrip onDismiss={dismiss}>
          <span>Snapshot proposal</span>
        </ComposerContextStrip>
        <Editor />
      </ComposerContextDock>
    </ComposerContextProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  const draft = screen.getByRole("textbox", { name: "Draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(dismiss).not.toHaveBeenCalled();
  expect(screen.getByText("Snapshot proposal")).toBeTruthy();
});
