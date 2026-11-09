// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, it, expect } from "vitest";
import { usePlanEditorOwner, useHasPlanEditor } from "./plan-editor-ownership";
afterEach(cleanup);
function Editor({
  name,
  priority,
  interactionKey,
  enabled = true,
}: {
  name: string;
  priority: number;
  interactionKey: string;
  enabled?: boolean;
}) {
  const owns = usePlanEditorOwner(interactionKey, priority, enabled);
  return owns ? <div data-testid="editor">{name}</div> : null;
}
function NativeFallback({ interactionKey }: { interactionKey: string }) {
  const hasPlan = useHasPlanEditor(interactionKey);
  return hasPlan ? null : <div data-testid="fallback">Native input</div>;
}
it("observes owner priority, enabled state, interaction identity and removal under compilation", () => {
  const body = (
    focused: boolean,
    overlay: boolean,
    panelKey = "question",
    panelEnabled = true,
  ) => (
    <>
      <Editor name="native" priority={0} interactionKey="question" />
      <NativeFallback interactionKey="question" />
      <Editor
        name="panel"
        priority={20}
        interactionKey={panelKey}
        enabled={panelEnabled}
      />
      {overlay && (
        <Editor
          name="overlay"
          priority={focused ? 30 : 10}
          interactionKey="question"
        />
      )}
    </>
  );
  const view = render(body(false, true));
  expect(screen.getByTestId("editor").textContent).toBe("panel");
  expect(screen.queryByTestId("fallback")).toBeNull();
  view.rerender(body(true, true));
  expect(screen.getByTestId("editor").textContent).toBe("overlay");
  view.rerender(body(false, false));
  expect(screen.getByTestId("editor").textContent).toBe("panel");
  view.rerender(body(false, false, "other-question"));
  expect(
    screen.getAllByTestId("editor").map((element) => element.textContent),
  ).toEqual(["native", "panel"]);
  expect(screen.getByTestId("fallback").textContent).toBe("Native input");
  view.rerender(body(false, false, "question", false));
  expect(screen.getByTestId("editor").textContent).toBe("native");
  expect(screen.getByTestId("fallback")).toBeDefined();
});
