// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { hasVisibleMatch } from "./visible-dom";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hasVisibleMatch", () => {
  it("finds a visible match", () => {
    document.body.innerHTML = '<div role="menu"></div>';
    expect(hasVisibleMatch('[role="menu"]')).toBe(true);
  });

  it("ignores matches that checkVisibility reports hidden", () => {
    document.body.innerHTML =
      '<div id="hidden" role="menu"></div><div id="shown" role="menu"></div>';
    const hidden = document.getElementById("hidden")!;
    hidden.checkVisibility = () => false;
    expect(hasVisibleMatch('[role="menu"]')).toBe(true);
    document.getElementById("shown")!.checkVisibility = () => false;
    expect(hasVisibleMatch('[role="menu"]')).toBe(false);
  });

  it("returns false without matches", () => {
    expect(hasVisibleMatch('[role="menu"]')).toBe(false);
  });
});
