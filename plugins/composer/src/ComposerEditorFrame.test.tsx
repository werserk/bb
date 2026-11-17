// @vitest-environment jsdom
import { useEffect, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerEditorFrame } from "./ComposerEditorFrame";
afterEach(cleanup);
it("moves the same mounted form above app stacking contexts and restores it with live controls", () => {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Editor() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <textarea aria-label="Draft" defaultValue="Keep the draft" />;
  }
  function Fixture() {
    const [expanded, setExpanded] = useState(false);
    const form = useRef<HTMLFormElement>(null);
    return (
      <div data-local-host="">
        <ComposerEditorFrame expanded={expanded}>
          <form ref={form} onSubmit={(event) => event.preventDefault()}>
            <Editor />
            <button type="button" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Collapse" : "Expand"}
            </button>
          </form>
        </ComposerEditorFrame>
      </div>
    );
  }
  const view = render(<Fixture />);
  const draft = screen.getByRole("textbox");
  const form = draft.closest("form");
  const local = view.container.querySelector("[data-local-host]");
  expect(local?.contains(form)).toBe(true);
  fireEvent.change(draft, { target: { value: "Edited draft" } });
  draft.focus();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(document.activeElement).toBe(draft);
  expect(local?.contains(form)).toBe(false);
  expect(form?.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByRole("textbox")).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Edited draft");
  expect(document.getElementById("root")?.hasAttribute("inert")).not.toBe(true);
  draft.focus();
  fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
  expect(document.activeElement).toBe(draft);
  expect(local?.contains(form)).toBe(true);
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
  view.unmount();
  expect(unmounted).toHaveBeenCalledOnce();
  expect(document.body.contains(form)).toBe(false);
});
