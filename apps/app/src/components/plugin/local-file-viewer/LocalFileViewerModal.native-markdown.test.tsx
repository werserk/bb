// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { FilePreview } from "@bb/client-core";
import { MarkdownLocalFileContextMenuContext } from "@/components/ui/markdown-link-routing";
import { LocalFileViewerModal } from "./LocalFileViewerModal";

const openCoreModal = vi.hoisted(() => vi.fn());
const panelOpen = vi.hoisted(() =>
  vi.fn(
    (_intent: import("@/lib/app-navigation-host").AppFilePreviewIntent) => true,
  ),
);
const editorOpen = vi.hoisted(() => vi.fn());
const pathExists = vi.hoisted(() =>
  vi.fn((_host: string, _path: string) => true),
);
vi.mock("@/hooks/queries/host-path-queries", () => ({
  useHostPathExists: pathExists,
}));
const contextAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation-host", () => ({
  useAppNavigationHost: () => ({ openFilePreview: panelOpen }),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/modal-host", () => ({ openCoreModal }));
vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: toastError },
}));
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
const source = vi.hoisted(() => ({ content: "" }));
function query(path: string) {
  const data: FilePreview = {
    kind: "text",
    content: source.content,
    mimeType: "text/markdown",
    name: path.split("/").at(-1),
    path,
    url: `/content/${path}`,
  };
  return {
    data,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  };
}
vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageLocation: () => ({
    data: { storageRootPath: "/storage", hostId: "host_test" },
  }),
  useThreadStorageFilePreview: (_threadId: string, path: string) => query(path),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({
    data: {
      id: "env_1",
      path: "/workspace",
      projectId: "proj_1",
      hostId: "host_workspace",
      hostLifecycle: "active",
      status: "active",
    },
  }),
  useEnvironmentFilePreview: (_environmentId: string, path: string) =>
    query(path),
}));
vi.mock("@/hooks/queries/host-file-preview-query", () => ({
  useHostFilePreview: (_hostId: string, path: string) => query(path),
}));

vi.mock("@/hooks/useLiveFileOpenTargets", () => ({
  useLiveFileOpenTargets: () => ({
    fileOpenTargets: [{ id: "vscode" }],
    openPathInFileTarget: editorOpen,
  }),
}));

const VIRTUAL_ROOT = "__bb_markdown_file_root__";
const LINKS = [
  "[Nested](nested.md)",
  "[Up](../shared.md)",
  "[Json](data.json)",
  "[Py](script.py)",
  "[Line](nested.md#L3)",
  `[Editor](vscode://file/${VIRTUAL_ROOT}/reports/nested.md:7)`,
  "[Escape](../../../outside.md)",
  "[Absolute](/etc/outside.md)",
  "[Picture](/etc/outside.png)",
  "[External](https://example.com/page.md)",
  "`inline.py`",
].join("\n\n");

const storage = {
  kind: "thread-storage",
  threadId: "thr_abcd234567",
  relativePath: "reports/report.md",
  path: "/storage/reports/report.md",
  lineRange: null,
};
const workspace = {
  kind: "workspace",
  environmentId: "env_1",
  relativePath: "reports/report.md",
  path: "/workspace/reports/report.md",
  lineRange: null,
};
const host = {
  kind: "host",
  hostId: "host_1",
  relativePath: "/docs/report.md",
  path: "/docs/report.md",
  lineRange: null,
};

function show(params: unknown) {
  return render(
    <MemoryRouter>
      <MarkdownLocalFileContextMenuContext.Provider
        value={(localLink) => [
          {
            id: "review-open",
            label: "Inspect resolved file",
            onSelect: () => contextAction(localLink),
          },
        ]}
      >
        <LocalFileViewerModal
          params={params as typeof storage}
          compact={false}
          close={vi.fn()}
        />
      </MarkdownLocalFileContextMenuContext.Provider>
    </MemoryRouter>,
  );
}
async function link(name: string): Promise<HTMLElement> {
  return screen.findByRole("link", { name });
}
function renderedHrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[href]")].map(
    (element) => element.getAttribute("href") ?? "",
  );
}
function openedPaths(): string[] {
  return openCoreModal.mock.calls.map(([, options]) => options.params.path);
}
beforeEach(() => {
  source.content = LINKS;
  openCoreModal.mockReset();
  toastError.mockReset();
  panelOpen.mockClear();
  editorOpen.mockClear();
  contextAction.mockClear();
  pathExists.mockClear();
});
afterEach(cleanup);

describe.each([
  ["thread-storage", storage],
  ["workspace", workspace],
] as const)("native %s Markdown body", (_name, params) => {
  beforeEach(() => {
    source.content = LINKS.replace(
      VIRTUAL_ROOT,
      params.kind === "workspace" ? "workspace" : "storage",
    );
  });

  it("uses the real .49 document root for file and editor hrefs", async () => {
    const { container } = show(params);
    await link("Nested");
    const root = params.kind === "workspace" ? "/workspace" : "/storage";
    expect(
      renderedHrefs(container).filter((href) => href.includes(VIRTUAL_ROOT)),
    ).toEqual([]);
    for (const [name, path] of [
      ["Nested", "reports/nested.md"],
      ["Up", "shared.md"],
      ["Json", "reports/data.json"],
      ["Py", "reports/script.py"],
      ["Line", "reports/nested.md#L3"],
    ]) {
      expect((await link(name!)).getAttribute("href")).toBe(
        `file://${root}/${path}`,
      );
    }
    expect(await link("Editor")).toBeTruthy();
    expect(await link("inline.py")).toBeTruthy();
    expect((await link("External")).getAttribute("href")).toBe(
      "https://example.com/page.md",
    );
  });

  it("replaces the one popup for an ordinary relative artifact link", async () => {
    show(params);
    expect(fireEvent.click(await link("Nested"))).toBe(false);
    expect(fireEvent.click(screen.getByRole("link", { name: "Up" }))).toBe(
      false,
    );
    expect(openedPaths()).toEqual(["reports/nested.md", "shared.md"]);
    const [id, options] = openCoreModal.mock.calls[0]!;
    expect(id).toBe("core/local-file-viewer");
    expect(options).toMatchObject({
      title: "nested.md",
      params: { relativePath: "reports/nested.md", lineRange: null },
    });
    expect(options.params.experimental_artifact).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("delegates modifiers and middle activation to the .49 preview resolver", async () => {
    show(params);
    const nested = await link("Nested");
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ])
      expect(fireEvent.click(nested, init)).toBe(false);
    expect(panelOpen).toHaveBeenCalledTimes(5);
    for (const [intent] of panelOpen.mock.calls)
      expect(intent).toMatchObject({
        target: {
          kind: params.kind,
          path: "reports/nested.md",
          ...(params.kind === "workspace"
            ? { environmentId: "env_1" }
            : { threadId: "thr_abcd234567" }),
        },
        location: null,
      });
    expect(openCoreModal).not.toHaveBeenCalled();
  });

  it("delegates code files and line locations with their scope and location", async () => {
    show(params);
    for (const name of ["Json", "Py", "Line", "inline.py"])
      expect(fireEvent.click(await link(name))).toBe(false);
    expect(panelOpen.mock.calls.map(([intent]) => intent)).toMatchObject([
      {
        target: { kind: params.kind, path: "reports/data.json" },
        location: null,
      },
      {
        target: { kind: params.kind, path: "reports/script.py" },
        location: null,
      },
      {
        target: { kind: params.kind, path: "reports/nested.md" },
        location: { kind: "range", startLine: 3, endLine: 3 },
      },
      {
        target: { kind: params.kind, path: "reports/inline.py" },
        location: null,
      },
    ]);
    expect(fireEvent.click(await link("External"))).toBe(true);
    expect(openCoreModal).not.toHaveBeenCalled();
  });

  it("keeps editor intents and inline-code context menus on real host paths", async () => {
    show(params);
    expect(fireEvent.click(await link("Editor"))).toBe(false);
    const root = params.kind === "workspace" ? "/workspace" : "/storage";
    expect(editorOpen).toHaveBeenCalledWith({
      path: `${root}/reports/nested.md`,
      lineNumber: 7,
      rememberTarget: false,
      targetId: "vscode",
    });
    expect(pathExists).toHaveBeenCalledWith(
      params.kind === "workspace" ? "host_workspace" : "host_test",
      `${root}/reports/inline.py`,
    );
    fireEvent.contextMenu(await link("inline.py"));
    fireEvent.click(await screen.findByText("Inspect resolved file"));
    expect(contextAction).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${root}/reports/inline.py` }),
    );
    expect(openCoreModal).not.toHaveBeenCalled();
    expect(panelOpen).not.toHaveBeenCalled();
  });

  it("shows unavailable with Copy path for ordinary unresolved local artifacts", async () => {
    show(params);
    for (const [name, href] of [
      ["Escape", "../../../outside.md"],
      ["Absolute", "/etc/outside.md"],
      ["Picture", "/etc/outside.png"],
    ] as const) {
      toastError.mockClear();
      expect(fireEvent.click(await link(name))).toBe(false);
      expect(toastError).toHaveBeenCalledWith(
        "Can't open this file here",
        expect.objectContaining({
          description: href,
          action: expect.objectContaining({ label: "Copy path" }),
        }),
      );
    }
    expect(openCoreModal).not.toHaveBeenCalled();
  });
});

describe("native Markdown body ownership", () => {
  it("keeps the owning thread for nested thread-storage files", async () => {
    show(storage);
    fireEvent.click(await link("Nested"));
    expect(openCoreModal.mock.calls[0]![1]).toMatchObject({
      context: "Report agent",
      params: { kind: "thread-storage", threadId: "thr_abcd234567" },
    });
    expect(screen.getByText("live:thr_abcd234567")).toBeTruthy();
  });

  it("keeps a workspace document inside its own environment without a chat", async () => {
    show(workspace);
    fireEvent.click(await link("Nested"));
    expect(openCoreModal.mock.calls[0]![1]).toMatchObject({
      params: { kind: "workspace", environmentId: "env_1" },
    });
    expect(screen.queryByText(/^live:/u)).toBeNull();
  });

  it("keeps a host document on its actual host, from its own directory, without a chat", async () => {
    source.content = [
      "[Nested](nested.md)",
      "[Deeper](sub/other.md)",
      "[Up](../up.md)",
      "[Sibling](/docs/abs.md)",
      "[Elsewhere](/etc/outside.md)",
    ].join("\n\n");
    const { container } = show(host);
    fireEvent.click(await link("Nested"));
    fireEvent.click(screen.getByRole("link", { name: "Deeper" }));
    fireEvent.click(screen.getByRole("link", { name: "Sibling" }));
    expect(openCoreModal.mock.calls.map(([, o]) => o.params)).toMatchObject([
      { kind: "host", hostId: "host_1", path: "/docs/nested.md" },
      { kind: "host", hostId: "host_1", path: "/docs/sub/other.md" },
      { kind: "host", hostId: "host_1", path: "/docs/abs.md" },
    ]);
    expect(screen.queryByText(/^live:/u)).toBeNull();
    for (const name of ["Up", "Elsewhere"]) {
      toastError.mockClear();
      expect(fireEvent.click(screen.getByRole("link", { name }))).toBe(false);
      expect(toastError).toHaveBeenCalledTimes(1);
    }
    expect(openCoreModal).toHaveBeenCalledTimes(3);
    expect(renderedHrefs(container)).toContain("file:///docs/nested.md");
    expect((await link("Nested")).getAttribute("href")).toBe(
      "file:///docs/nested.md",
    );
    expect(
      fireEvent.click(screen.getByRole("link", { name: "Nested" }), {
        ctrlKey: true,
      }),
    ).toBe(false);
    expect(panelOpen).toHaveBeenLastCalledWith({
      target: { kind: "host", hostId: "host_1", path: "/docs/nested.md" },
      location: null,
    });
    expect(openCoreModal).toHaveBeenCalledTimes(3);
  });
});
