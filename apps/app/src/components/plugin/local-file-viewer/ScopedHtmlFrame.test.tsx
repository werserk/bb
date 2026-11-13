// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ScopedHtmlFrame } from "./ScopedHtmlFrame";
import { artifactHtmlDocument, decodeArtifactHtml } from "./artifact-html";
afterEach(cleanup);
it("mounts fetched HTML only in an escaped inner srcdoc under an opaque static guard", () => {
  const content =
    '<h1>Report</h1><script>parent.document.body.textContent="escape"</script></iframe><img id="outer-escape">';
  render(
    <ScopedHtmlFrame
      content={content}
      url="/api/v1/file-previews/id/nested/report.html"
      baseUrl="/api/v1/file-previews/id"
      title="report.html"
    />,
  );
  const frame = screen.getByTitle("report.html") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.hasAttribute("src")).toBe(false);
  const outer = new DOMParser().parseFromString(frame.srcdoc, "text/html");
  expect(outer.querySelector("#outer-escape")).toBeNull();
  expect(outer.scripts).toHaveLength(0);
  const inner = outer.querySelector("iframe")!;
  expect(inner.getAttribute("sandbox")).toBe("allow-scripts");
  expect(inner.getAttribute("srcdoc")).toContain(content);
  expect(
    outer
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content"),
  ).toContain("frame-src 'none'");
  expect(
    screen.getByText("Links to other documents are blocked in this preview."),
  ).toBeTruthy();
});
it("refuses a wrapper URL outside its exact lease", () => {
  expect(() =>
    artifactHtmlDocument(
      "html",
      "https://example.test/native/doc.html",
      "https://example.test/api/v1/file-previews/id/",
    ),
  ).toThrow("outside");
});
it("preserves BOM decoding and rejects an unexpected HTTP charset", () => {
  expect(
    decodeArtifactHtml(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      "text/html; charset=utf-8",
    ),
  ).toBe("a");
  expect(
    decodeArtifactHtml(
      new Uint8Array([0xfe, 0xff, 0, 0x61]),
      "text/html; charset=utf-8",
    ),
  ).toBe("a");
  expect(() =>
    decodeArtifactHtml(new Uint8Array(), "text/html; charset=windows-1251"),
  ).toThrow("charset");
});
