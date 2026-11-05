// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HashNavigationScroll } from "./App";
import { resetModalHostForTest } from "@/lib/modal-host";

let navigateTo: (to: string, state?: unknown) => void = () => {};

function Controls() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (to, state) => void navigate(to, { state });
  }, [navigate]);
  return null;
}

describe("HashNavigationScroll", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    window.history.replaceState(null, "", "/#anchor");
    scrollIntoView.mockReset();
    Element.prototype.scrollIntoView = scrollIntoView;
    const target = document.createElement("section");
    target.id = "anchor";
    document.body.append(target);
  });

  afterEach(() => {
    cleanup();
    document.getElementById("anchor")?.remove();
    resetModalHostForTest();
  });

  function mount() {
    render(
      <BrowserRouter>
        <Controls />
        <HashNavigationScroll />
      </BrowserRouter>,
    );
  }

  it("scrolls to the hash target on load", () => {
    mount();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not scroll again when only a modal entry is pushed or popped", async () => {
    mount();
    const modal = {
      v: 1,
      token: "t",
      kind: "core",
      modalId: "core/x",
      title: "X",
      params: {},
    };

    act(() => navigateTo("/#anchor", { bbModal: modal }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    act(() => window.history.back());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("still scrolls when the hash changes", async () => {
    mount();
    act(() => navigateTo("/#anchor2"));
    const second = document.createElement("section");
    second.id = "anchor2";
    document.body.append(second);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    second.remove();

    expect(scrollIntoView.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
