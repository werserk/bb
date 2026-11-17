// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ExperimentalComposerEditor } from "@get-bb/plugin-sdk";
import { ComposerRoot, ComposerRootHostContext } from "./composer-root";
import { ComposerContextProvider } from "./context/composer-context";
import { ComposerContextStrip } from "./context/ComposerContextStrip";
import { ComposerContextDock } from "./context/ComposerContextDock";

afterEach(cleanup);
it("asks the renderer to expose the same native context strip for any plugin preview", () => {
  const expose = vi.fn();
  const editor: ExperimentalComposerEditor = {
    state: {
      layout: "expanded",
      isRunning: false,
      isSubmitting: false,
      isSubmittingBlocked: false,
      submittingBlockedReason: null,
      isAttaching: false,
      attachmentError: null,
    },
    focus: () => true,
    focusEnd: () => {},
    insertAtCursor: () => false,
    acceptsThreadDrop: () => false,
    insertDroppedThreads: () => {},
    openPopup: () => false,
    closePopup: () => false,
    isPopupOpen: () => false,
  };
  function Fixture() {
    const root = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState(false);
    return (
      <ComposerContextProvider>
        <ComposerRootHostContext.Provider
          value={{
            key: "preview",
            registerEditor: () => () => {},
            attachEditor: () => () => {},
            onFocusCommand: undefined,
            reportMenuLayout: null,
            runsPluginCommands: false,
            isFocusedPane: true,
          }}
        >
          <ComposerContextDock>
            <div ref={root}>
              <ComposerRoot
                rootRef={root}
                editor={editor}
                experimental_onContextPreview={expose}
              />
              <button onClick={() => setPreview(!preview)}>
                Toggle preview
              </button>
              {preview && (
                <ComposerContextStrip onDismiss={() => setPreview(false)}>
                  Plugin proposal
                </ComposerContextStrip>
              )}
            </div>
          </ComposerContextDock>
        </ComposerRootHostContext.Provider>
      </ComposerContextProvider>
    );
  }
  render(<Fixture />);
  expect(expose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
  expect(expose).toHaveBeenCalledOnce();
  expect(
    screen.getByText("Plugin proposal").closest(".composer-context-strip"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
  expect(expose).toHaveBeenCalledOnce();
});
