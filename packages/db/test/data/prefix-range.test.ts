import { describe, expect, it } from "vitest";
import { codePointPrefixRange } from "../../src/data/prefix-range.js";

describe("codePointPrefixRange", () => {
  it.each([
    ["ASCII", "abc", "abd"],
    ["percent", "50%", "50&"],
    ["underscore", "a_b", "a_c"],
    ["backslash", "c\\", "c]"],
    ["BMP letter", "проект", "проеку"],
    ["astral character", "😀", "😁"],
    ["last BMP code point", "a\u{ffff}", "a\u{10000}"],
  ])("bounds a %s prefix", (_name, prefix, upper) => {
    expect(codePointPrefixRange(prefix)).toEqual({ lower: prefix, upper });
  });

  it("drops trailing U+10FFFF code points and increments the one before", () => {
    expect(codePointPrefixRange("ab\u{10ffff}\u{10ffff}")).toEqual({
      lower: "ab\u{10ffff}\u{10ffff}",
      upper: "ac",
    });
  });

  it("has no upper bound when every code point is U+10FFFF", () => {
    expect(codePointPrefixRange("\u{10ffff}\u{10ffff}")).toEqual({
      lower: "\u{10ffff}\u{10ffff}",
      upper: null,
    });
  });

  it("orders a lone surrogate between U+D7FF and U+E000, as the driver stores it", () => {
    expect(codePointPrefixRange("a\u{d7ff}")).toEqual({
      lower: "a\u{d7ff}",
      upper: "a\ud800",
    });
    expect(codePointPrefixRange("a\ud800")).toEqual({
      lower: "a\ud800",
      upper: "a\ud801",
    });
    expect(codePointPrefixRange("\udc00b")).toEqual({
      lower: "\udc00b",
      upper: "\udc00c",
    });
    expect(codePointPrefixRange("a\udfff")).toEqual({
      lower: "a\udfff",
      upper: "a\u{e000}",
    });
  });

  it("does not let the bound pair a lone high surrogate with a low one", () => {
    expect(codePointPrefixRange("x\ud800\udbff")).toEqual({
      lower: "x\ud800\udbff",
      upper: "x\ud800\u{e000}",
    });
  });

  it("has no upper bound for empty input", () => {
    expect(codePointPrefixRange("")).toEqual({ lower: "", upper: null });
  });
});
