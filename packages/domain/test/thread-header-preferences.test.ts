import { describe, expect, it } from "vitest";
import {
  getUiPreferenceDefault,
  parseUiPreferenceValue,
} from "../src/ui-preferences.js";

describe("thread header preference", () => {
  it("defaults to a calm header", () => {
    expect(getUiPreferenceDefault("threadHeader.pinned")).toEqual([]);
  });
  it("keeps ordered unknown keys and removes duplicates", () => {
    expect(
      parseUiPreferenceValue("threadHeader.pinned", [
        "gone/action",
        "wprojects/threads",
        "gone/action",
      ]),
    ).toEqual({ success: true, value: ["gone/action", "wprojects/threads"] });
  });
  it.each([null, "wprojects/threads", [1], [""]])(
    "rejects malformed input %j",
    (value) => {
      expect(parseUiPreferenceValue("threadHeader.pinned", value).success).toBe(
        false,
      );
    },
  );
});
