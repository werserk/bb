// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEmbeddedLocalFileLinkHandler } from "./useEmbeddedLocalFileLinkHandler";

const STORAGE_ROOT = "/home/me/.bb/thread-storage/thr_own";

const mocks = vi.hoisted(() => ({
  filePreview: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageLocation: () => ({
    data: {
      hostId: "host_1",
      storageRootPath: "/home/me/.bb/thread-storage/thr_own",
    },
  }),
  useThreadStorageFilePreview: (...args: unknown[]) =>
    mocks.filePreview(...args),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock("@/components/secondary-panel/ThreadStorageFilePreview", () => ({
  SecondaryPanelFilePreview: (props: {
    activePath: string;
    filePreview?: { kind: string; name?: string };
  }) => (
    <div data-testid="preview">
      {props.filePreview?.kind === "unsupported"
        ? `No preview for ${props.activePath}`
        : `preview:${props.activePath}`}
    </div>
  ),
}));

function Harness({
  environmentId = "env_1",
}: {
  environmentId?: string | null;
}) {
  const { onOpenLocalFileLink, viewer } = useEmbeddedLocalFileLinkHandler({
    enabled: true,
    environmentId,
    threadId: "thr_own",
    workspaceRootPath: "/home/me/work/repo",
  });
  const open = (path: string) =>
    onOpenLocalFileLink?.({ lineRange: null, openTargetId: null, path }) ??
    null;
  return (
    <>
      <button
        type="button"
        onClick={() => open(`${STORAGE_ROOT}/shots/a1.png`)}
      >
        open storage
      </button>
      <button type="button" onClick={() => open("/etc/passwd")}>
        open outside
      </button>
      <button
        type="button"
        onClick={() => {
          window.__routeResult = open("/projects/proj_abc/threads/thr_abc");
        }}
      >
        open route
      </button>
      {viewer}
    </>
  );
}

declare global {
  interface Window {
    __routeResult?: boolean | null;
  }
}

beforeEach(() => {
  mocks.filePreview.mockReset();
  mocks.toastError.mockReset();
  mocks.filePreview.mockReturnValue({
    data: undefined,
    error: null,
    isFetching: false,
    isLoading: true,
    refetch: vi.fn(),
  });
});
afterEach(cleanup);

describe("useEmbeddedLocalFileLinkHandler", () => {
  it("opens a thread-storage file in the viewer dialog", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open storage"));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("a1.png")).not.toBeNull();
    expect(screen.getByTestId("preview").textContent).toBe(
      "preview:shots/a1.png",
    );
    expect(mocks.filePreview).toHaveBeenCalledWith(
      "thr_own",
      "shots/a1.png",
      expect.anything(),
    );
    expect(
      screen.getByRole("link", { name: "Download" }).getAttribute("href"),
    ).toContain("/threads/thr_own/thread-storage/files/shots/a1.png");
  });

  it("shows the unsupported-file fallback from the preview surface", () => {
    mocks.filePreview.mockReturnValue({
      data: {
        kind: "unsupported",
        path: "export.bin",
        url: "/x",
        mimeType: "application/octet-stream",
        sizeBytes: 18,
        reason: "binary",
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });
    render(<Harness />);
    fireEvent.click(screen.getByText("open storage"));
    expect(screen.getByTestId("preview").textContent).toContain(
      "No preview for",
    );
  });

  it("toasts and makes no preview request for a path outside served roots", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.filePreview).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Can't open this file here",
      expect.objectContaining({ description: "/etc/passwd" }),
    );
  });

  it("leaves app routes to normal navigation", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open route"));
    expect(window.__routeResult).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and returns focus to the link", async () => {
    render(<Harness />);
    const trigger = screen.getByText("open storage");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
