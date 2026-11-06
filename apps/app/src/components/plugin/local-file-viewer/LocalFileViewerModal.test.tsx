// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LocalFileViewerModal } from "./LocalFileViewerModal";
import {
  ModalBodyBoundary,
  ModalBodyError,
} from "@/components/modal/ModalBodyError";

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { title: "Report agent", projectId: "proj_1" } }),
}));
const previewState = vi.hoisted(() => ({
  value: { data: undefined, isError: false } as {
    data: unknown;
    isError: boolean;
  },
}));
vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageFilePreview: () => previewState.value,
}));
vi.mock("@/components/plugin/local-file-viewer/PdfViewerFrame", () => ({
  isPdfPath: (path: string) => path.endsWith(".pdf"),
  PdfViewerFrame: () => <div>pdf frame</div>,
}));
vi.mock("@/components/plugin/PluginThreadChat", () => ({
  PluginThreadChat: ({ threadId }: { threadId: string }) => (
    <div>live:{threadId}</div>
  ),
}));
vi.mock("@/components/secondary-panel/ThreadSecondaryPanelTabContent", () => ({
  ThreadStorageFilePreviewTabContent: () => <div>storage preview</div>,
  WorkspaceFilePreviewTabContent: () => <div>workspace preview</div>,
}));
const params = {
  kind: "thread-storage",
  threadId: "thr_abcd234567",
  relativePath: "report.md",
  path: "/storage/report.md",
  lineRange: null,
};
afterEach(cleanup);
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}:{String(location.state?.bbModal ?? "")}
    </output>
  );
}
function show(value: unknown = params, compact = false) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: "/before", state: { bbModal: "open" } }]}
    >
      <Location />
      <LocalFileViewerModal
        params={value as typeof params}
        compact={compact}
        close={vi.fn()}
      />
    </MemoryRouter>,
  );
}
describe("LocalFileViewerModal", () => {
  it("shows the artifact with its live chat and named navigation", () => {
    show();
    expect(screen.getByText("storage preview")).toBeTruthy();
    expect(screen.getByText("live:thr_abcd234567")).toBeTruthy();
    expect(screen.getByText("Report agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open thread" })).toBeTruthy();
  });
  it("opens the named thread and removes modal history state", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(screen.getByTestId("location").textContent).toContain(
      "thr_abcd234567",
    );
    expect(screen.getByTestId("location").textContent).not.toContain("open");
  });
  it("shows workspace files alone without guessing", () => {
    show({ ...params, kind: "workspace", environmentId: "env_1" });
    expect(screen.getByText("workspace preview")).toBeTruthy();
    expect(screen.queryByText("live:thr_abcd234567")).toBeNull();
  });
  it("defaults to Artifact on phone and switches tabs", () => {
    show(params, true);
    expect(
      screen
        .getByRole("tab", { name: "Artifact" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(
      screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByText("live:thr_abcd234567")
        .closest("[role=tabpanel]")
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });
  it("reaches the PDF frame's own error state when the preview query fails", () => {
    const pdf = { ...params, relativePath: "doc.pdf", path: "/storage/doc.pdf" };
    previewState.value = { data: undefined, isError: false };
    const view = show(pdf);
    expect(screen.getByText("Loading PDF…")).toBeTruthy();
    view.unmount();
    previewState.value = { data: undefined, isError: true };
    show(pdf);
    expect(screen.getByText("pdf frame")).toBeTruthy();
  });
  it("fails through ModalBodyError for invalid history params", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ModalBodyBoundary
        fallback={<ModalBodyError onRetry={vi.fn()} onClose={vi.fn()} />}
      >
        <LocalFileViewerModal params={null} compact={false} close={vi.fn()} />
      </ModalBodyBoundary>,
    );
    expect(screen.getByRole("alert").hasAttribute("data-bb-modal-error")).toBe(
      true,
    );
    spy.mockRestore();
  });
});
