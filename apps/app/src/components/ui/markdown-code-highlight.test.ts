import { readFileSync } from "node:fs";
import { highlight } from "sugar-high";
import { describe, expect, it, vi } from "vitest";
import { highlightMarkdownCode } from "./markdown-code-highlight.js";

vi.mock("sugar-high", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sugar-high")>();
  return { ...actual, highlight: vi.fn(actual.highlight) };
});

const stylesheet = readFileSync(
  new URL("./markdown-code-highlight.css", import.meta.url),
  "utf8",
);

function tokens(html: string | null): Array<[string, string]> {
  expect(html).not.toBeNull();
  return [
    ...(html ?? "").matchAll(/class="sh__token--(\w+)"[^>]*>([^<]*)<\/span>/g),
  ].map((match) => [match[1]!, match[2]!]);
}

function tokenTypes(html: string | null): string[] {
  return tokens(html).map(([type]) => type);
}

describe("highlightMarkdownCode", () => {
  const shell = "# install the plugin\nbb plugin install ./plugins/monokai";

  it.each(["sh", "bash", "shell", "zsh", "console", "shellscript"])(
    "lexes a `#` comment in a %s fence as a comment, not a JS sign",
    (language) => {
      const html = highlightMarkdownCode({ code: shell, language });
      expect(tokens(html)).toContainEqual(["comment", "# install the plugin"]);
      expect(tokenTypes(html)).not.toContain("string");
    },
  );

  it.each([null, "ruby"])(
    "keeps the JavaScript lexer for a fence with language %j",
    (language) => {
      const html = highlightMarkdownCode({
        code: "const a = 1 // hi",
        language,
      });
      expect(tokens(html)).toContainEqual(["keyword", "const"]);
      expect(tokens(html)).toContainEqual(["comment", "// hi"]);
    },
  );

  it("keeps the previously mapped aliases highlighted", () => {
    expect(
      tokens(highlightMarkdownCode({ code: "# c\nx = 1", language: "py" })),
    ).toContainEqual(["comment", "# c"]);
    expect(
      tokens(highlightMarkdownCode({ code: "int main() {}", language: "hpp" })),
    ).toContainEqual(["class", "int"]);
    expect(
      tokens(
        highlightMarkdownCode({ code: "a { color: red }", language: "less" }),
      ),
    ).toContainEqual(["property", "color"]);
    expect(
      tokens(highlightMarkdownCode({ code: "fun f() {}", language: "kt" })),
    ).toContainEqual(["keyword", "fun"]);
  });

  it("highlights languages agents emit that v1 never mapped", () => {
    expect(
      tokens(
        highlightMarkdownCode({ code: "# top\nkey: v", language: "yaml" }),
      ),
    ).toContainEqual(["comment", "# top"]);
    expect(
      tokens(
        highlightMarkdownCode({ code: "-- c\nSELECT 1", language: "sql" }),
      ),
    ).toContainEqual(["comment", "-- c"]);
  });

  it("styles every semantic line class emitted for a diff", () => {
    const code = [
      "diff --git a/config.ini b/config.ini",
      "--- a/config.ini",
      "+++ b/config.ini",
      "@@ -1 +1 @@",
      "-enabled=false",
      "+enabled=true",
    ].join("\n");
    const html = highlightMarkdownCode({ code, language: "diff" });

    for (const role of ["add", "remove", "hunk", "meta"]) {
      expect(html).toContain(`sh__line--diff-${role}`);
      expect(stylesheet).toContain(
        `.bb-code-highlight .sh__line--diff-${role}`,
      );
    }

    expect(stylesheet).toMatch(
      /\.bb-code-highlight \.sh__line\s*\{[^}]*display: inline-block;[^}]*min-width: 100%;[^}]*\}/u,
    );
    expect(stylesheet).toMatch(
      /\.bb-code-highlight \.sh__line--diff-add\s*\{[^}]*var\(--diff-added\)[^}]*\}/u,
    );
    expect(stylesheet).toMatch(
      /\.bb-code-highlight \.sh__line--diff-remove\s*\{[^}]*var\(--diff-removed\)[^}]*\}/u,
    );
  });

  it("highlights a repeated code block once per language", () => {
    const code = "# cached note\nconst cached = 1;";
    vi.mocked(highlight).mockClear();

    const typescript = highlightMarkdownCode({ code, language: "ts" });
    expect(highlightMarkdownCode({ code, language: "ts" })).toBe(typescript);
    expect(highlight).toHaveBeenCalledTimes(1);

    const shell = highlightMarkdownCode({ code, language: "sh" });
    expect(highlight).toHaveBeenCalledTimes(2);
    expect(tokens(shell)).toContainEqual(["comment", "# cached note"]);
    expect(tokens(typescript)).not.toContainEqual(["comment", "# cached note"]);
    expect(highlightMarkdownCode({ code, language: "sh" })).toBe(shell);
    expect(highlightMarkdownCode({ code, language: null })).not.toBe(shell);
    expect(highlight).toHaveBeenCalledTimes(3);
  });

  it("keeps representative code through 1000 lines and 128_000 characters highlighted and cached", () => {
    const thousandLines = "const value = compute(input, { flag: true });\n"
      .repeat(1000)
      .trimEnd();
    const longest = " ".repeat(128_000);
    vi.mocked(highlight).mockClear();

    for (const code of [thousandLines, thousandLines, longest, longest]) {
      highlightMarkdownCode({ code, language: null });
    }
    expect(highlight).toHaveBeenCalledTimes(2);
    expect(
      highlightMarkdownCode({ code: thousandLines, language: null }),
    ).not.toBeNull();
    expect(
      highlightMarkdownCode({ code: longest, language: null }),
    ).not.toBeNull();
  });

  it.each(["\n", "\r\n", "\r"])(
    "skips highlighting above 1000 lines separated by %j",
    (newline) => {
      const atLimit = Array.from(
        { length: 1000 },
        () => "const line = 1;",
      ).join(newline);
      expect(
        highlightMarkdownCode({ code: atLimit, language: "js" }),
      ).not.toBeNull();
      const code = Array.from({ length: 1001 }, () => "const line = 1;").join(
        newline,
      );
      vi.mocked(highlight).mockClear();
      expect(highlightMarkdownCode({ code, language: "js" })).toBeNull();
      expect(highlight).not.toHaveBeenCalled();
    },
  );

  it("skips the measured 4000-line control and oversized input before invoking the highlighter", () => {
    vi.mocked(highlight).mockClear();
    for (const code of [
      "Synthetic code control\n".repeat(4000).trimEnd(),
      " ".repeat(128_001),
    ]) {
      expect(highlightMarkdownCode({ code, language: null })).toBeNull();
    }
    expect(highlight).not.toHaveBeenCalled();
  });

  it("caches a plain sentinel for dense markup instead of rebuilding or storing escaped source", () => {
    const code = "a+".repeat(26_000);
    vi.mocked(highlight).mockClear();
    expect(highlightMarkdownCode({ code, language: "js" })).toBeNull();
    expect(highlightMarkdownCode({ code, language: "js" })).toBeNull();
    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("recomputes the least recently used code block past 128 entries and past the character budget", () => {
    const countBlock = (index: number) =>
      `const countEntry${index} = ${index};`;
    for (let index = 0; index < 129; index += 1) {
      highlightMarkdownCode({ code: countBlock(index), language: "js" });
    }
    vi.mocked(highlight).mockClear();

    highlightMarkdownCode({ code: countBlock(1), language: "js" });
    highlightMarkdownCode({ code: countBlock(128), language: "js" });
    expect(highlight).not.toHaveBeenCalled();
    highlightMarkdownCode({ code: countBlock(0), language: "js" });
    expect(highlight).toHaveBeenCalledTimes(1);
    highlightMarkdownCode({ code: countBlock(1), language: "js" });
    expect(highlight).toHaveBeenCalledTimes(1);
    highlightMarkdownCode({ code: countBlock(2), language: "js" });
    expect(highlight).toHaveBeenCalledTimes(2);

    const budgetBlock = (index: number) =>
      `const budget${index} = 0${"+a".repeat(1_500)};`;
    let distinctChars = 0;
    for (let index = 0; index < 20; index += 1) {
      const code = budgetBlock(index);
      distinctChars +=
        code.length +
        (highlightMarkdownCode({ code, language: "ts" })?.length ?? 0);
    }
    expect(distinctChars).toBeGreaterThan(4_000_000);
    vi.mocked(highlight).mockClear();

    highlightMarkdownCode({ code: budgetBlock(19), language: "ts" });
    expect(highlight).not.toHaveBeenCalled();
    highlightMarkdownCode({ code: countBlock(1), language: "js" });
    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("evicts plain sentinels by entry count and charges their source keys against the character budget", () => {
    const dense = (index: number) =>
      `const sentinel${index} = ${"a+".repeat(26_000)}0;`;
    const expandedMarkup = "x".repeat(4_100_000);
    const original = dense(0);
    vi.mocked(highlight).mockReturnValueOnce(expandedMarkup);
    expect(
      highlightMarkdownCode({ code: original, language: "js" }),
    ).toBeNull();
    for (let index = 1; index <= 80; index += 1) {
      vi.mocked(highlight).mockReturnValueOnce(expandedMarkup);
      expect(
        highlightMarkdownCode({ code: dense(index), language: "js" }),
      ).toBeNull();
    }
    vi.mocked(highlight).mockClear();
    expect(
      highlightMarkdownCode({ code: dense(80), language: "js" }),
    ).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
    expect(
      highlightMarkdownCode({ code: original, language: "js" }),
    ).toBeNull();
    expect(highlight).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 128; index += 1) {
      highlightMarkdownCode({
        code: `const afterSentinel${index} = 1;`,
        language: "js",
      });
    }
    vi.mocked(highlight).mockClear();
    expect(
      highlightMarkdownCode({ code: original, language: "js" }),
    ).toBeNull();
    expect(highlight).toHaveBeenCalledTimes(1);
    highlightMarkdownCode({
      code: "const afterSentinel127 = 1;",
      language: "js",
    });
    expect(highlight).toHaveBeenCalledTimes(1);
  });
});
