// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { ComposerBox } from "@/components/promptbox/ComposerBox";
import { registerComposerPlugin } from "@/test/fixtures/composer-plugin";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { testTypeaheadConfig } from "@/test/fixtures/composer-search";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { openArtifactPopup } from "@/lib/artifact-activation";
import {
  closeModal,
  registerCoreModal,
  resetModalHostForTest,
} from "@/lib/modal-host";
import { LocalFileViewerModal } from "@/components/plugin/local-file-viewer/LocalFileViewerModal";
import { ModalHost } from "./ModalHost";

vi.mock("@/hooks/usePromptMentions", async () =>
  (await import("@/test/fixtures/composer-search")).fakePromptMentionsModule(),
);
vi.mock("@/hooks/useCommandSuggestions", async () =>
  (
    await import("@/test/fixtures/composer-search")
  ).fakeCommandSuggestionsModule(),
);
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: { title: "Draft owner", projectId: "proj_draft_probe" },
  }),
}));
vi.mock("@/components/plugin/PluginThreadChat", () => ({
  PluginThreadChat: () => <Composer place="modal" />,
}));
vi.mock("@/components/code/BbSourceCodeSplit", () => ({
  BbSourceCodeSplit: { preload: () => Promise.resolve() },
}));
vi.mock("@/lib/sdk", () => ({
  sdk: {
    files: {
      createPreview: async () => ({
        policy: "artifact-v1",
        expectedSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
        baseUrl: "/api/v1/file-previews/draft",
      }),
    },
  },
}));
vi.mock("@/lib/app-surface", () => ({
  fetchWithAppSurface: async () =>
    new Response("# Draft artifact\n\n[Next](next.md)"),
}));

const threadId = "thr_abcd234567";
const scope = {
  kind: "thread" as const,
  projectId: "proj_draft_probe",
  threadId,
};
let storageKey = "";
let modalMounts = 0;
function Composer({ place }: { place: string }) {
  const draft = usePromptDraftStorage(scope);
  storageKey = draft.storageKey;
  useEffect(() => {
    if (place === "modal") modalMounts += 1;
  }, [place]);
  return (
    <div data-testid={`${place}-composer`}>
      <ComposerBox
        surface="thread"
        value={draft.text}
        mentionRanges={draft.mentions}
        onChange={draft.setTextAndMentions}
        onSubmit={() => {}}
        typeahead={testTypeaheadConfig()}
        mentionMenuPlacement="bottom"
      />
    </div>
  );
}
function Page() {
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <Composer key={generation} place="page" />
      <button onClick={() => setGeneration((value) => value + 1)}>
        Remount composer
      </button>
    </>
  );
}
function editor(place: string) {
  const element = screen
    .getByTestId(`${place}-composer`)
    .querySelector(".ProseMirror") as TiptapEditorHTMLElement | null;
  if (!element?.editor) throw new Error("Real composer editor missing");
  return element;
}
afterEach(() => {
  cleanup();
  resetModalHostForTest();
  resetPluginSlotStoreForTest();
});

it("preserves exact real ComposerBox text and stored draft across nested popup replacement, close and forced remount", async () => {
  await registerComposerPlugin();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  const client = new QueryClient();
  const caller = new AbortController();
  const open = () =>
    openArtifactPopup({
      target: { kind: "thread-storage", threadId, path: "nested/report.md" },
      location: null,
      experimental_artifact: {
        version: 1,
        readRoot: "nested",
        physicalSource: { hostId: "primary", canonicalReadRoot: "/source/A" },
        lifetime: caller.signal,
        revalidate: async () => true,
      },
    });
  registerCoreModal("core/local-file-viewer", LocalFileViewerModal);
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <TooltipProvider>
          <Page />
          <ModalHost />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(editor("page")).toBeTruthy());
  const exact = "Exact α → 👨‍💻 draft <tag> & `code`  два  spaces";
  act(() => {
    editor("page").editor!.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: exact }] },
      ],
    });
  });
  await waitFor(() => expect(editor("page").editor!.getText()).toBe(exact));
  act(() => {
    open();
  });
  await screen.findByRole("heading", { name: "Draft artifact" });
  const firstEditor = editor("modal");
  expect(firstEditor.editor!.getText()).toBe(exact);
  fireEvent.click(screen.getByRole("link", { name: "Next" }));
  await waitFor(() => expect(modalMounts).toBe(2));
  expect(editor("modal")).not.toBe(firstEditor);
  expect(editor("modal").editor!.getText()).toBe(exact);
  act(() => closeModal());
  await waitFor(() =>
    expect(screen.queryByTestId("modal-composer")).toBeNull(),
  );
  const before = editor("page");
  fireEvent.click(screen.getByRole("button", { name: "Remount composer" }));
  await waitFor(() => expect(editor("page")).not.toBe(before));
  expect(editor("page").editor!.getText()).toBe(exact);
  await waitFor(() =>
    expect(JSON.parse(window.localStorage.getItem(storageKey)!).text).toBe(
      exact,
    ),
  );
  act(() => {
    open();
  });
  await waitFor(() => expect(modalMounts).toBe(3));
  expect(editor("modal").editor!.getText()).toBe(exact);
  caller.abort();
  client.clear();
});
