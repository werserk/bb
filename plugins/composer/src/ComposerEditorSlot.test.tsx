// @vitest-environment jsdom
import { useRef, useState } from "react";
import { Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerEditorSlot } from "./ComposerEditorSlot";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reports overflow, expands the same editor and removes the affordance when the draft fits", async () => {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content: "<p>Keep the draft</p>",
  });
  const height = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(120);
  const scroll = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(360);
  function Fixture() {
    const ref = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    return (
      <>
        <ComposerEditorSlot
          editor={editor}
          scrollContainerRef={ref}
          inputLocked={false}
          isCompactLayout={false}
          suggestionVisible={false}
          minHeight={80}
          layout="thread"
          resolveMentionLink={undefined}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
        {expanded && (
          <button onClick={() => setExpanded(false)}>Collapse</button>
        )}
      </>
    );
  }
  const view = render(<Fixture />);
  try {
    expect(await screen.findByText("10 more lines ·")).toBeTruthy();
    const dom = editor.view.dom;
    expect(
      view.container.querySelector<HTMLElement>(
        "[data-promptbox-editor-scroll]",
      )?.style.maxHeight,
    ).toContain("--composer-editor-cap");
    fireEvent.click(screen.getByRole("button", { name: "Expand ⤢" }));
    expect(editor.view.dom).toBe(dom);
    expect(editor.getText()).toBe("Keep the draft");
    expect(screen.queryByRole("button", { name: "Expand ⤢" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(editor.view.dom).toBe(dom);
    height.mockReturnValue(120);
    scroll.mockReturnValue(120);
    act(() => {
      editor.commands.setContent("<p>Short</p>");
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Expand ⤢" })).toBeNull(),
    );
  } finally {
    view.unmount();
    editor.destroy();
  }
});
