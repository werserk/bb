import { describe, expect, it, vi } from "vitest";
import {
  configChanged,
  notifyConfigChangedIfChanged,
} from "./config-change.js";

describe("config change hints", () => {
  it("Same value written: sends no hint for an equal configuration in another key order", () => {
    const hub = { notifySystem: vi.fn() };
    const changed = configChanged(
      { theme: "nord", nested: { a: 1, b: [1, 2] }, omitted: undefined },
      { nested: { b: [1, 2], a: 1 }, theme: "nord" },
    );
    expect(changed).toBe(false);
    expect(notifyConfigChangedIfChanged(hub, changed)).toBe(false);
    expect(hub.notifySystem).not.toHaveBeenCalled();
  });

  it("Real change: sends exactly one hint", () => {
    const hub = { notifySystem: vi.fn() };
    const changed = configChanged(
      { theme: "nord", nested: { b: [1, 2] } },
      { theme: "nord", nested: { b: [2, 1] } },
    );
    expect(changed).toBe(true);
    expect(notifyConfigChangedIfChanged(hub, changed)).toBe(true);
    expect(hub.notifySystem).toHaveBeenCalledTimes(1);
    expect(hub.notifySystem).toHaveBeenCalledWith(["config-changed"]);
    expect(configChanged({ value: null }, {})).toBe(true);
  });
});
