// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEmbeddedLocalFileLinkHandler } from "./useEmbeddedLocalFileLinkHandler";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  toast: vi.fn(),
  entity: vi.fn(),
}));
vi.mock("@/lib/modal-host", () => ({ openCoreModal: mocks.open }));
vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: mocks.toast },
}));
vi.mock("@/hooks/cache-owners/thread-entity-store", () => ({
  getThreadEntity: mocks.entity,
}));
vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageLocation: () => ({
    data: { storageRootPath: "/home/me/.bb/thread-storage/thr_abcd234567" },
  }),
}));

const STORAGE_PATH = "/home/me/.bb/thread-storage/thr_abcd234567/report.md";
const OTHER_PATH = "/home/me/.bb/thread-storage/thr_bcde234567/new.pdf";
const APP_ROUTE = "/projects/proj_abc/threads/thr_abc";

function Handler({ enabled = true }: { enabled?: boolean }) {
  const { onOpenLocalFileLink } = useEmbeddedLocalFileLinkHandler({
    enabled,
    environmentId: "env_1",
    threadId: "thr_abcd234567",
    workspaceRootPath: "/repo",
  });
  return (
    <>
      {[STORAGE_PATH, OTHER_PATH, "/etc/passwd", APP_ROUTE].map(path => (
        <button
          key={path}
          onClick={() => onOpenLocalFileLink?.({
            path,
            lineRange: null,
            openTargetId: null,
          })}
        >
          {path}
        </button>
      ))}
    </>
  );
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <Handler enabled={enabled} />
    </QueryClientProvider>
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("useEmbeddedLocalFileLinkHandler", () => {
  it("opens the shared modal and replaces the target on a second link", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText(STORAGE_PATH));
    expect(mocks.open).toHaveBeenLastCalledWith(
      "core/local-file-viewer",
      expect.objectContaining({
        title: "report.md",
        params: expect.objectContaining({
          threadId: "thr_abcd234567",
          relativePath: "report.md",
        }),
      }),
    );
    fireEvent.click(screen.getByText(OTHER_PATH));
    expect(mocks.open).toHaveBeenLastCalledWith(
      "core/local-file-viewer",
      expect.objectContaining({
        title: "new.pdf",
        params: expect.objectContaining({ threadId: "thr_bcde234567" }),
      }),
    );
  });

  it("uses a cached thread title within the host text limit", () => {
    mocks.entity.mockReturnValue({ thread: { title: "a".repeat(201) } });
    render(<Harness />);
    fireEvent.click(screen.getByText(STORAGE_PATH));
    expect(mocks.open.mock.calls[0]?.[1].context).toBe("a".repeat(200));
  });

  it("toasts for unavailable paths without opening", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("/etc/passwd"));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "Can't open this file here",
      expect.objectContaining({ description: "/etc/passwd" }),
    );
  });

  it("leaves app routes to navigation", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText(APP_ROUTE));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", () => {
    render(<Harness enabled={false} />);
    fireEvent.click(screen.getByText(STORAGE_PATH));
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
