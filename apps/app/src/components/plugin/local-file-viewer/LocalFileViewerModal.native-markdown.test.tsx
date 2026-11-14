// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { FilePreview } from "@bb/client-core";
import { LocalFileViewerModal } from "./LocalFileViewerModal";

const openCoreModal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/modal-host", () => ({ openCoreModal }));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: (id: string) => ({
    data: id ? { title: "Report agent", projectId: "proj_1" } : undefined,
  }),
}));
vi.mock("@/components/plugin/PluginThreadChat", () => ({
  PluginThreadChat: ({ threadId }: { threadId: string }) => (
    <div>live:{threadId}</div>
  ),
}));
const document = vi.hoisted(() => ({ content: "" }));
function preview(path: string): FilePreview {
  return {
    kind: "text",
    content: document.content,
    mimeType: "text/markdown",
    name: path.split("/").at(-1),
    path,
    url: `/content/${path}`,
  };
}
function query(path: string) {
  return {
    data: preview(path),
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  };
}
vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageFilePreview: (_threadId: string, path: string) => query(path),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: { path: "/workspace", projectId: "proj_1" } }),
  useEnvironmentFilePreview: (_environmentId: string, path: string) =>
    query(path),
}));

const storage = (relativePath: string) => ({
  kind: "thread-storage",
  threadId: "thr_abcd234567",
  relativePath,
  path: `/storage/${relativePath}`,
  lineRange: null,
});
function show(params: unknown) {
  return render(
    <MemoryRouter>
      <LocalFileViewerModal
        params={params as ReturnType<typeof storage>}
        compact={false}
        close={vi.fn()}
      />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  document.content = [
    "[Nested](nested.md)",
    "[Sibling](./deeper/other.md)",
    "[Code](code.ts)",
    "[Escape](../../outside.md)",
    "[Line](nested.md#L3)",
  ].join("\n\n");
  openCoreModal.mockReset();
});
afterEach(cleanup);

describe("native Markdown body inside the artifact popup", () => {
  it("replaces the one popup with the linked thread-storage file and keeps the owning thread", async () => {
    show(storage("report.md"));
    const link = await screen.findByRole("link", { name: "Nested" });
    expect(fireEvent.click(link)).toBe(false);
    expect(openCoreModal).toHaveBeenCalledTimes(1);
    const [id, options] = openCoreModal.mock.calls[0]!;
    expect(id).toBe("core/local-file-viewer");
    expect(options).toMatchObject({
      title: "nested.md",
      context: "Report agent",
      params: {
        kind: "thread-storage",
        threadId: "thr_abcd234567",
        path: "nested.md",
        relativePath: "nested.md",
        lineRange: null,
      },
    });
    expect(options.params.experimental_artifact).toBeUndefined();
  });

  it("resolves relative links from the document's own directory", async () => {
    show(storage("docs/report.md"));
    fireEvent.click(await screen.findByRole("link", { name: "Nested" }));
    fireEvent.click(screen.getByRole("link", { name: "Sibling" }));
    expect(openCoreModal.mock.calls.map(([, o]) => o.params.path)).toEqual([
      "docs/nested.md",
      "docs/deeper/other.md",
    ]);
  });

  it("keeps modified clicks, line ranges, non-artifact files and namespace escapes on the anchor", async () => {
    show(storage("report.md"));
    const nested = await screen.findByRole("link", { name: "Nested" });
    expect(fireEvent.click(nested, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(nested, { metaKey: true })).toBe(true);
    expect(fireEvent.click(screen.getByRole("link", { name: "Line" }))).toBe(
      true,
    );
    expect(fireEvent.click(screen.getByRole("link", { name: "Code" }))).toBe(
      true,
    );
    expect(fireEvent.click(screen.getByRole("link", { name: "Escape" }))).toBe(
      true,
    );
    expect(openCoreModal).not.toHaveBeenCalled();
  });

  it("keeps a workspace document inside its own environment", async () => {
    show({
      kind: "workspace",
      environmentId: "env_1",
      relativePath: "docs/report.md",
      path: "/workspace/docs/report.md",
      lineRange: null,
    });
    fireEvent.click(await screen.findByRole("link", { name: "Nested" }));
    expect(openCoreModal.mock.calls[0]![1]).toMatchObject({
      params: {
        kind: "workspace",
        environmentId: "env_1",
        path: "docs/nested.md",
      },
    });
    expect(screen.queryByText(/^live:/u)).toBeNull();
  });
});
