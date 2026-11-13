// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollArea } from "./scroll-area";

vi.mock("@radix-ui/react-scroll-area", () => {
  const Box = ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  );
  return {
    Root: Box,
    Viewport: Box,
    ScrollAreaScrollbar: Box,
    ScrollAreaThumb: Box,
    Corner: Box,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ScrollArea drag visibility", () => {
  it.each(["pointerup", "pointercancel"])(
    "releases drag visibility on window %s without lost capture",
    (eventType) => {
      const { container } = render(<ScrollArea overlay>Content</ScrollArea>);
      const root = container.querySelector("[data-overlay-scroll-area]")!;
      const bar = container.querySelector(".bb-overlay-scrollbar")!;
      fireEvent(
        bar,
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      expect(root.getAttribute("data-dragging")).toBe("true");

      fireEvent(window, new Event(eventType));

      expect(root.hasAttribute("data-dragging")).toBe(false);
    },
  );

  it("removes window release listeners when unmounted during a drag", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { container, unmount } = render(<ScrollArea overlay />);
    fireEvent(
      container.querySelector(".bb-overlay-scrollbar")!,
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );

    unmount();

    expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("pointercancel", expect.any(Function));
  });
});
