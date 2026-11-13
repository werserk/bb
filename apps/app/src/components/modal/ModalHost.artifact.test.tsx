// @vitest-environment jsdom
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openArtifactPopup } from "@/lib/artifact-activation";
import { hasLiveArtifactAdmission } from "@/lib/artifact-admission";
import {
  closeModal,
  openCoreModal,
  registerCoreModal,
  resetModalHostForTest,
} from "@/lib/modal-host";
import { LocalFileViewerModal } from "@/components/plugin/local-file-viewer/LocalFileViewerModal";
import { ModalHost } from "./ModalHost";

const transport = vi.hoisted(() => ({ create: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  sdk: { files: { createPreview: transport.create } },
}));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: transport.fetch }));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { title: "Owner", projectId: "p" } }),
}));
vi.mock("@/components/plugin/PluginThreadChat", () => ({
  PluginThreadChat: () => <div>owner chat</div>,
}));
vi.mock("@/components/code/BbSourceCodeSplit", () => ({
  BbSourceCodeSplit: { preload: () => Promise.resolve() },
}));

let client: QueryClient;
let caller: AbortController;
let revalidate: ReturnType<
  typeof vi.fn<
    (request: {
      target: import("@get-bb/plugin-sdk").ExperimentalLiveFileTarget;
      readRoot: string;
      signal: AbortSignal;
    }) => Promise<boolean>
  >
>;
const target = {
  kind: "thread-storage" as const,
  threadId: "thr_abcd234567",
  path: "nested/report.md",
};
const token = () => window.history.state?.usr?.bbModal?.token as string;
function open(path = target.path) {
  return openArtifactPopup({
    target: { ...target, path },
    location: null,
    experimental_artifact: {
      version: 1,
      readRoot: "nested",
      revalidate,
      lifetime: caller.signal,
    },
  });
}
function show() {
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ModalHost />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  caller = new AbortController();
  revalidate = vi.fn(async () => true);
  transport.create.mockResolvedValue({
    baseUrl: "/api/v1/file-previews/lease",
    policy: "artifact-v1",
  });
  transport.fetch.mockImplementation(
    async () => new Response("# Report\n\n[Next](next.md)"),
  );
  registerCoreModal("core/local-file-viewer", LocalFileViewerModal);
  registerCoreModal("core/other", () => <div>other modal</div>);
});
afterEach(() => {
  cleanup();
  client.clear();
  resetModalHostForTest();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("serializes only scope/target, repeats admission on refresh, and transfers nested custody", async () => {
  show();
  act(() => {
    expect(open()).toBe(true);
  });
  expect(await screen.findByRole("heading", { name: "Report" })).toBeTruthy();
  const first = token();
  expect(window.history.state.usr.bbModal.params.experimental_artifact).toEqual(
    { version: 1, readRoot: "nested" },
  );
  expect(Object.keys(window.history.state.usr.bbModal)).toEqual(
    expect.arrayContaining(["token", "params"]),
  );
  expect(JSON.stringify(window.history.state)).not.toMatch(
    /revalidate|lifetime|signal|handle/,
  );
  expect(revalidate).toHaveBeenCalledTimes(1);
  const firstSignal = revalidate.mock.calls[0]![0].signal;
  fireEvent.click(screen.getByRole("button", { name: "Refresh file" }));
  await waitFor(() => expect(revalidate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("link", { name: "Next" }));
  await waitFor(() => expect(revalidate).toHaveBeenCalledTimes(3));
  expect(token()).not.toBe(first);
  expect(hasLiveArtifactAdmission(first)).toBe(false);
  expect(firstSignal.aborted).toBe(true);
  expect(revalidate.mock.calls[2]![0]).toMatchObject({
    target: { ...target, path: "nested/next.md" },
    readRoot: "nested",
  });
  await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(3));
  expect(transport.fetch.mock.calls[2]![0]).toBe(
    "/api/v1/file-previews/lease/next.md",
  );
});

it.each(["close", "back", "caller", "replace", "unbind", "reset"])(
  "disposes on %s and a late callback cannot lease, fetch or reopen",
  async (action) => {
    let complete!: (value: boolean) => void;
    revalidate.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const view = show();
    act(() => {
      open();
    });
    await waitFor(() => expect(revalidate).toHaveBeenCalledTimes(1));
    const old = token();
    act(() => {
      if (action === "close") closeModal();
      else if (action === "back") window.history.back();
      else if (action === "caller") caller.abort();
      else if (action === "replace")
        openCoreModal("core/other", { title: "Other" });
      else if (action === "reset") resetModalHostForTest();
      else view.unmount();
    });
    await settle();
    expect(hasLiveArtifactAdmission(old)).toBe(false);
    expect(revalidate.mock.calls[0]![0].signal.aborted).toBe(true);
    await act(async () => {
      complete(true);
      await Promise.resolve();
    });
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
  },
);

it("strips scoped Forward after close while the existing native history suite remains unchanged", async () => {
  show();
  act(() => {
    open();
  });
  await screen.findByRole("heading", { name: "Report" });
  const old = token();
  act(() => closeModal());
  await settle();
  const reads = transport.fetch.mock.calls.length;
  act(() => window.history.forward());
  await settle();
  expect(window.history.state?.usr?.bbModal).toBeUndefined();
  expect(hasLiveArtifactAdmission(old)).toBe(false);
  expect(screen.queryByText("owner chat")).toBeNull();
  expect(transport.fetch).toHaveBeenCalledTimes(reads);
});

it("drops overwritten and caller-aborted queued records before any admission", async () => {
  show();
  act(() => openCoreModal("core/other", { title: "Other" }));
  await settle();
  const newId = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const ids: string[] = [];
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
    const id = newId();
    ids.push(id);
    return id;
  });
  const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
  act(() => {
    closeModal();
    open("nested/first.md");
    const first = ids.at(-1)!;
    expect(hasLiveArtifactAdmission(first)).toBe(true);
    open("nested/second.md");
    const second = ids.at(-1)!;
    expect(hasLiveArtifactAdmission(first)).toBe(false);
    expect(hasLiveArtifactAdmission(second)).toBe(true);
    caller.abort();
    expect(hasLiveArtifactAdmission(second)).toBe(false);
  });
  go.mockRestore();
  act(() => window.history.back());
  await settle();
  expect(revalidate).not.toHaveBeenCalled();
  expect(transport.create).not.toHaveBeenCalled();
  expect(transport.fetch).not.toHaveBeenCalled();
  expect(screen.queryByText("owner chat")).toBeNull();
});

it("only admits the last queued candidate after dismissal completes", async () => {
  show();
  act(() => openCoreModal("core/other", { title: "Other" }));
  await settle();
  act(() => {
    closeModal();
    open("nested/first.md");
    open("nested/second.md");
  });
  await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1));
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(revalidate.mock.calls[0]![0].target.path).toBe("nested/second.md");
});

it("a scoped history entry without ephemeral custody is stale before a byte request", async () => {
  window.history.replaceState(
    {
      usr: {
        keep: 1,
        bbModal: {
          v: 1,
          token: "restored",
          kind: "core",
          modalId: "core/local-file-viewer",
          title: "Old",
          params: {
            ...target,
            relativePath: target.path,
            lineRange: null,
            experimental_artifact: { version: 1, readRoot: "nested" },
          },
        },
      },
      key: "k",
      idx: 0,
    },
    "",
    "/",
  );
  show();
  await settle();
  expect(window.history.state.usr).toEqual({ keep: 1 });
  expect(revalidate).not.toHaveBeenCalled();
  expect(transport.create).not.toHaveBeenCalled();
  expect(transport.fetch).not.toHaveBeenCalled();
});

it("PDF Retry re-admits before any new lease or PDF byte fetch", async () => {
  const pdfFetch = vi.fn(async () => new Response(null, { status: 403 }));
  vi.stubGlobal("fetch", pdfFetch);
  show();
  act(() => {
    open("nested/report.pdf");
  });
  await screen.findByText(/Failed to load PDF/);
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(transport.create).toHaveBeenCalledTimes(1);
  revalidate.mockResolvedValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Artifact admission refused");
  expect(revalidate).toHaveBeenCalledTimes(2);
  expect(transport.create).toHaveBeenCalledTimes(1);
  expect(pdfFetch).toHaveBeenCalledTimes(1);
});
it("query invalidation re-admits and refusal/error UI Retry admits once per new attempt", async () => {
  revalidate.mockResolvedValue(false);
  show();
  act(() => {
    open();
  });
  await screen.findByText("Artifact admission refused");
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(transport.create).not.toHaveBeenCalled();
  revalidate.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Report" });
  expect(revalidate).toHaveBeenCalledTimes(2);
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["artifact-v1"] });
  });
  await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2));
  expect(revalidate).toHaveBeenCalledTimes(3);
});

it("consumes unsupported nested links without falling back to an unscoped navigation", async () => {
  transport.fetch.mockImplementation(
    async () => new Response("# Report\n\n[Source](code.ts)"),
  );
  show();
  act(() => {
    open();
  });
  const source = await screen.findByRole("link", { name: "Source" });
  const current = token();
  expect(fireEvent.click(source)).toBe(false);
  expect(token()).toBe(current);
  expect(window.location.pathname).toBe("/");
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(transport.create).toHaveBeenCalledTimes(1);
});
