// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPdfPath, PdfViewerFrame } from "./PdfViewerFrame";

function pdfResponse(contentType: string, status = 200): Response {
  return new Response(new Blob(["%PDF-1.4"]), {
    headers: { "content-type": contentType },
    status,
  });
}

describe("PdfViewerFrame", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:pdf-1");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("matches .pdf paths case-insensitively and nothing else", () => {
    expect(isPdfPath("reports/Q1.PDF")).toBe(true);
    expect(isPdfPath("notes.pdf.txt")).toBe(false);
    expect(isPdfPath("pdf")).toBe(false);
  });

  it("renders a verified PDF in a frame from a blob url", async () => {
    fetchMock.mockResolvedValue(pdfResponse("application/pdf"));
    render(<PdfViewerFrame title="doc.pdf" url="/api/v1/x/doc.pdf" />);
    const frame = await screen.findByTitle("doc.pdf");
    expect(frame.getAttribute("src")).toBe("blob:pdf-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/x/doc.pdf",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("pins the blob type to application/pdf and revokes the url on unmount", async () => {
    fetchMock.mockResolvedValue(pdfResponse("application/pdf; charset=binary"));
    const { unmount } = render(
      <PdfViewerFrame title="doc.pdf" url="/api/v1/x/doc.pdf" />,
    );
    await screen.findByTitle("doc.pdf");
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/pdf");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf-1");
  });

  it("refuses a response that is not application/pdf", async () => {
    fetchMock.mockResolvedValue(pdfResponse("text/html"));
    render(<PdfViewerFrame title="doc.pdf" url="/api/v1/x/doc.pdf" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not a PDF document");
    expect(screen.queryByTitle("doc.pdf")).toBeNull();
  });

  it("shows the status and offers Retry on a failed request", async () => {
    fetchMock.mockResolvedValueOnce(pdfResponse("application/pdf", 404));
    render(<PdfViewerFrame title="doc.pdf" url="/api/v1/x/doc.pdf" />);
    expect((await screen.findByRole("alert")).textContent).toContain("404");
    fetchMock.mockResolvedValueOnce(pdfResponse("application/pdf"));
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(screen.getByTitle("doc.pdf")).toBeTruthy());
  });
});
