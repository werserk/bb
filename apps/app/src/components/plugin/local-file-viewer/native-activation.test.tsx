// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { LazyMarkdownHtml } from "@/components/ui/lazy-markdown-html";
import { PluginMarkdown } from "../PluginMarkdown";
import { useRetainedThreadTabFrame } from "../RetainedThreadTabFrame";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { ConversationAttachments } from "@/components/thread/timeline/ConversationAttachments";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import { ExperimentalFileLink } from "../ExperimentalFileLink";
import { useEmbeddedLocalFileLinkHandler } from "./useEmbeddedLocalFileLinkHandler";

const mocks = vi.hoisted(() => ({
  modal: vi.fn(),
  panel: vi.fn((_intent: unknown) => true),
}));
vi.mock("@/lib/modal-host", () => ({ openCoreModal: mocks.modal }));
vi.mock("@/hooks/queries/thread-panel-queries", () => ({
  useThreadStorageLocation: () => ({
    data: { storageRootPath: "/home/me/.bb/thread-storage/thr_abcd234567" },
  }),
}));

beforeAll(() => LazyMarkdownHtml.preload());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const path = "/home/me/.bb/thread-storage/thr_abcd234567/report.md";
const modified = [
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
];

function Embedded({
  ambient = false,
  attachment = false,
  content = `[report](${path})`,
}) {
  const handler = useEmbeddedLocalFileLinkHandler({
    enabled: true,
    artifactsOnly: ambient,
    environmentId: "env_embedded",
    threadId: "thr_abcd234567",
    workspaceRootPath: "/embedded",
  });
  const onOpenLink = (
    link: Parameters<NonNullable<typeof handler.onOpenLocalFileLink>>[0],
  ) => handler.onOpenLocalFileLink?.(link) || (ambient && mocks.panel(link));
  return attachment ? (
    <ConversationAttachments
      filePaths={[path]}
      fileDetails={[]}
      imageItems={[]}
      onOpenLocalFileLink={onOpenLink}
    />
  ) : (
    <MarkdownPreview
      content={content}
      linkRouting={{
        localFile: { absoluteLinks: { kind: "trusted-host" }, onOpenLink },
      }}
    />
  );
}

function showEmbedded(props: Parameters<typeof Embedded>[0] = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Embedded {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it.each([false, true])(
  "opens an ordinary embedded artifact with actual custody (ambient=%s)",
  (ambient) => {
    showEmbedded({ ambient });
    expect(
      fireEvent.click(screen.getByRole("link", { name: "report" }), {
        detail: 0,
      }),
    ).toBe(false);
    expect(mocks.modal).toHaveBeenCalledTimes(1);
    expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
      kind: "thread-storage",
      threadId: "thr_abcd234567",
      relativePath: "report.md",
    });
    expect(mocks.panel).not.toHaveBeenCalled();
  },
);

it.each(modified)("keeps the embedded ambient baseline for %j", (event) => {
  showEmbedded({ ambient: true });
  expect(
    fireEvent.click(screen.getByRole("link", { name: "report" }), event),
  ).toBe(false);
  expect(mocks.modal).not.toHaveBeenCalled();
  expect(mocks.panel).toHaveBeenCalledWith(
    expect.objectContaining({ path, ordinaryActivation: false }),
  );
});

it.each(modified)(
  "keeps the different-environment embedded baseline for %j",
  (event) => {
    showEmbedded();
    expect(
      fireEvent.click(screen.getByRole("link", { name: "report" }), event),
    ).toBe(false);
    expect(mocks.modal).toHaveBeenCalledTimes(1);
    expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
      path,
      relativePath: "report.md",
    });
  },
);

it.each([false, true])(
  "preserves explicit-editor embedded fallback (ambient=%s)",
  (ambient) => {
    showEmbedded({ ambient, content: `[report](vscode://file${path}:7)` });
    expect(fireEvent.click(screen.getByRole("link", { name: "report" }))).toBe(
      false,
    );
    if (ambient) {
      expect(mocks.modal).not.toHaveBeenCalled();
      expect(mocks.panel).toHaveBeenCalledWith(
        expect.objectContaining({
          openTargetId: "vscode",
          lineRange: { startLineNumber: 7, endLineNumber: 7 },
        }),
      );
    } else {
      expect(mocks.panel).not.toHaveBeenCalled();
      expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
        path,
        lineRange: { startLineNumber: 7, endLineNumber: 7 },
      });
    }
  },
);

it.each([{}, ...modified])(
  "carries attachment activation through the embedded chain for %j",
  (event) => {
    showEmbedded({ ambient: true, attachment: true });
    fireEvent.click(screen.getByRole("button", { name: /report.md/ }), event);
    if (Object.keys(event).length === 0) {
      expect(mocks.modal).toHaveBeenCalledTimes(1);
      expect(mocks.panel).not.toHaveBeenCalled();
    } else {
      expect(mocks.modal).not.toHaveBeenCalled();
      expect(mocks.panel).toHaveBeenCalledWith(
        expect.objectContaining({ path, ordinaryActivation: false }),
      );
    }
  },
);

it.each([{}, ...modified])(
  "keeps contextual Markdown activation and location for %j",
  (event) => {
    render(
      <AppNavigationHostProvider
        capabilities={{ openFilePreview: mocks.panel }}
      >
        <PluginMarkdown
          experimental_document={{
            target: {
              kind: "workspace",
              environmentId: "env_document",
              path: "nested/report.md",
            },
            rootPath: "/document",
            threadId: "thr_abcd234567",
          }}
          content="[report](next.md) [lines](next.md#L3-L5)"
        />
      </AppNavigationHostProvider>,
    );
    expect(
      fireEvent.click(screen.getByRole("link", { name: "report" }), event),
    ).toBe(false);
    if (Object.keys(event).length === 0) {
      expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
        environmentId: "env_document",
        relativePath: "nested/next.md",
      });
      expect(mocks.panel).not.toHaveBeenCalled();
    } else {
      expect(mocks.modal).not.toHaveBeenCalled();
      expect(mocks.panel).toHaveBeenCalledWith({
        target: {
          kind: "workspace",
          environmentId: "env_document",
          path: "nested/next.md",
        },
        location: null,
      });
    }
    fireEvent.click(screen.getByRole("link", { name: "lines" }));
    expect(mocks.panel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        location: { kind: "range", startLine: 3, endLine: 5 },
      }),
    );
  },
);

it.each(["download", "prevented"])(
  "keeps the contextual Markdown baseline for %s",
  (kind) => {
    render(
      <div
        onClickCapture={
          kind === "prevented" ? (event) => event.preventDefault() : undefined
        }
      >
        <AppNavigationHostProvider
          capabilities={{ openFilePreview: mocks.panel }}
        >
          <PluginMarkdown
            content="[report](next.md)"
            experimental_document={{
              target: {
                kind: "workspace",
                environmentId: "env_document",
                path: "report.md",
              },
              rootPath: "/document",
              threadId: "thr_abcd234567",
            }}
          />
        </AppNavigationHostProvider>
      </div>,
    );
    const link = screen.getByRole("link", { name: "report" });
    if (kind === "download") link.setAttribute("download", "");
    expect(fireEvent.click(link)).toBe(false);
    expect(mocks.modal).not.toHaveBeenCalled();
    expect(mocks.panel).toHaveBeenCalledWith({
      target: {
        kind: "workspace",
        environmentId: "env_document",
        path: "next.md",
      },
      location: null,
    });
  },
);

it.each([{}, ...modified, { download: true }, { prevented: true }])(
  "preserves semantic FileLink activation for %j",
  (event) => {
    render(
      <MemoryRouter>
        <AppNavigationHostProvider
          capabilities={{ openFilePreview: mocks.panel }}
        >
          <ExperimentalFileLink
            target={{
              kind: "workspace",
              environmentId: "env_semantic",
              path: "report.md",
            }}
            download={"download" in event ? "" : undefined}
            onClick={
              "prevented" in event ? (e) => e.preventDefault() : undefined
            }
          >
            report
          </ExperimentalFileLink>
        </AppNavigationHostProvider>
      </MemoryRouter>,
    );
    const result = fireEvent.click(
      screen.getByRole("link", { name: "report" }),
      event,
    );
    expect(mocks.panel).not.toHaveBeenCalled();
    if (Object.keys(event).length === 0) {
      expect(result).toBe(false);
      expect(mocks.modal).toHaveBeenCalledTimes(1);
    } else {
      expect(mocks.modal).not.toHaveBeenCalled();
      expect(result).toBe(!("prevented" in event));
    }
  },
);

function RetainedRelay({ allowed }: { allowed: () => boolean }) {
  const frame = useRetainedThreadTabFrame();
  return frame(
    <PluginMarkdown content="[report](/workspace/report.md)" />,
    allowed,
  );
}

it("preserves activation metadata and live allowed gate through the retained context relay", () => {
  let allowed = true;
  const callback = vi.fn(() => true);
  render(
    <MemoryRouter>
      <ThreadTimelineNavigationProvider
        environmentId="env_retained"
        onOpenLink={() => false}
        onOpenLocalFileLink={callback}
        resolveMentionLink={() => null}
        workspaceRootPath="/workspace"
      >
        <RetainedRelay allowed={() => allowed} />
      </ThreadTimelineNavigationProvider>
    </MemoryRouter>,
  );
  const link = screen.getByRole("link", { name: "report" });
  expect(fireEvent.click(link)).toBe(false);
  expect(callback).toHaveBeenLastCalledWith({
    path: "/workspace/report.md",
    lineRange: null,
    openTargetId: null,
    ordinaryActivation: true,
  });
  fireEvent.click(link, { metaKey: true });
  expect(callback).toHaveBeenLastCalledWith({
    path: "/workspace/report.md",
    lineRange: null,
    openTargetId: null,
    ordinaryActivation: false,
  });
  callback.mockClear();
  allowed = false;
  expect(fireEvent.click(link)).toBe(true);
  expect(callback).not.toHaveBeenCalled();
});
