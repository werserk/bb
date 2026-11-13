// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_PREVIEW_HTML_MAX_BYTES,
  FILE_PREVIEW_SAMPLE_BYTES,
  FILE_PREVIEW_TEXT_MAX_BYTES,
} from "@bb/client-core";
import { environmentQueryKey } from "@/hooks/queries/query-keys";
import type { LocalFileViewerTarget } from "@/lib/local-file-viewer-target";
import { LocalFileViewerModal } from "./LocalFileViewerModal";

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: () => {},
  useThreadTimelineRealtimeSubscription: () => {},
  useEnvironmentDetailRealtimeSubscription: () => {},
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: { title: "Native file owner", projectId: "proj_1" },
  }),
}));
vi.mock("@/components/plugin/PluginThreadChat", () => ({
  PluginThreadChat: () => <div>Native owner chat</div>,
}));
vi.mock("@/components/code/BbSourceCodeSplit", () => ({
  BbSourceCodeSplit: { preload: () => Promise.resolve() },
}));
vi.mock("@/components/code/SourceCodeHost", () => ({
  SourceCodeHost: () => <div data-testid="source-code" />,
}));

type Fixture = {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  declaredSize?: number;
};
const fixtures = new Map<string, Fixture>();
const clients: QueryClient[] = [];
const requests: Array<{ path: string; method: string; range: string | null }> =
  [];
const encoder = new TextEncoder();
const threadId = "thr_abcd234567";
const prefix = "/api/v1";

const nativeTargets = [
  {
    kind: "workspace",
    environmentId: "env_native",
    path: "/workspace/docs/report.md",
    relativePath: "docs/report.md",
    lineRange: null,
    route: `${prefix}/environments/env_native/files/docs/report.md`,
    assetRoute: `${prefix}/environments/env_native/files/docs/.assets/chart.png`,
  },
  {
    kind: "thread-storage",
    threadId,
    path: `/storage/${threadId}/docs/report.md`,
    relativePath: "docs/report.md",
    lineRange: null,
    route: `${prefix}/threads/${threadId}/thread-storage/files/docs/report.md`,
    assetRoute: `${prefix}/threads/${threadId}/thread-storage/files/docs/.assets/chart.png`,
  },
  {
    kind: "host",
    hostId: "host_native",
    path: "/host/docs/report.md",
    relativePath: "/host/docs/report.md",
    lineRange: null,
    route: `${prefix}/hosts/host_native/files/host/docs/report.md`,
    assetRoute: `${prefix}/hosts/host_native/files/host/docs/.assets/chart.png`,
  },
] satisfies Array<
  LocalFileViewerTarget & { route: string; assetRoute: string }
>;

function put(path: string, text: string, mime: string, declaredSize?: number) {
  fixtures.set(path, { bytes: encoder.encode(text), mime, declaredSize });
}

function show(target: LocalFileViewerTarget) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(environmentQueryKey("env_native"), {
    path: "/workspace",
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LocalFileViewerModal params={target} compact={false} close={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function readRenderedResource(element: Element, expectedPath: string) {
  expect(element.getAttribute("src")).toBe(expectedPath);
  const response = await fetch(element.getAttribute("src")!);
  expect(response.ok).toBe(true);
  return response.text();
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      const range = new Headers(init?.headers).get("range");
      requests.push({ path, method, range });
      const fixture = fixtures.get(path);
      if (!fixture || method !== "GET")
        throw new Error(`Unexpected native request: ${method} ${path}`);
      const bytes = range
        ? fixture.bytes.slice(0, FILE_PREVIEW_SAMPLE_BYTES)
        : fixture.bytes;
      return new Response(bytes, {
        status: range ? 206 : 200,
        headers: {
          "content-type": fixture.mime,
          ...(range
            ? {
                "content-range": `bytes 0-${bytes.length - 1}/${fixture.declaredSize ?? fixture.bytes.length}`,
              }
            : {}),
        },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  expect(requests.some(({ path }) => path.includes("file-previews"))).toBe(
    false,
  );
  fixtures.clear();
  requests.length = 0;
  vi.unstubAllGlobals();
});

describe.each(nativeTargets)("native $kind popup transport", (target) => {
  it("loads Markdown above the scoped text cap and retains dot-directory image bytes", async () => {
    const markdown = `<!--${"x".repeat(2 * 1024 * 1024)}-->\n\n# Native markdown complete\n\n![native chart](.assets/chart.png)`;
    put(target.route, markdown, "text/markdown");
    put(target.assetRoute, "native-dot-asset", "image/png");
    show(target);
    expect(
      await screen.findByRole("heading", { name: "Native markdown complete" }),
    ).toBeTruthy();
    expect(
      requests
        .filter(({ path }) => path === target.route)
        .map(({ range }) => range),
    ).toEqual([`bytes=0-${FILE_PREVIEW_SAMPLE_BYTES - 1}`, null]);
    expect(
      await readRenderedResource(
        screen.getByRole("img", { name: "native chart" }),
        target.assetRoute,
      ),
    ).toBe("native-dot-asset");
    for (const download of screen.getAllByRole("link", {
      name: "Download",
    })) {
      expect(download.getAttribute("href")).toBe(target.route);
    }
  });

  it("keeps the native HTML iframe cap and sandbox above the scoped text cap", async () => {
    expect(FILE_PREVIEW_HTML_MAX_BYTES).toBe(5 * 1024 * 1024);
    const route = target.route.replace(/\.md$/, ".html");
    const html = `<!doctype html><html><body><!--${"x".repeat(3 * 1024 * 1024)}-->Native HTML complete</body></html>`;
    put(route, html, "text/html");
    show({
      ...target,
      path: target.path.replace(/\.md$/, ".html"),
      relativePath: target.relativePath.replace(/\.md$/, ".html"),
    });
    const iframe = await waitFor(() => {
      const frame = document.querySelector("iframe");
      expect(frame).not.toBeNull();
      return frame!;
    });
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await readRenderedResource(iframe, route)).toBe(html);
    expect(
      requests.filter(({ path }) => path === route).map(({ range }) => range),
    ).toEqual([`bytes=0-${FILE_PREVIEW_SAMPLE_BYTES - 1}`, null, null]);
  });

  it("renders HTML above 5 MiB as source rather than an iframe", async () => {
    const route = target.route.replace(/\.md$/, ".html");
    const html = `<!doctype html><!--${"x".repeat(FILE_PREVIEW_HTML_MAX_BYTES)}-->`;
    put(route, html, "text/html");
    show({
      ...target,
      path: target.path.replace(/\.md$/, ".html"),
      relativePath: target.relativePath.replace(/\.md$/, ".html"),
    });
    expect(await screen.findByTestId("source-code")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      requests.filter(({ path }) => path === route).map(({ range }) => range),
    ).toEqual([`bytes=0-${FILE_PREVIEW_SAMPLE_BYTES - 1}`, null]);
  });

  it("retains the 25 MiB native text rejection without requesting full bytes", async () => {
    expect(FILE_PREVIEW_TEXT_MAX_BYTES).toBe(25 * 1024 * 1024);
    put(
      target.route,
      "x".repeat(FILE_PREVIEW_SAMPLE_BYTES),
      "text/markdown",
      FILE_PREVIEW_TEXT_MAX_BYTES + 1,
    );
    show(target);
    expect(await screen.findByText(/too large/i)).toBeTruthy();
    expect(requests).toEqual([
      {
        path: target.route,
        method: "GET",
        range: `bytes=0-${FILE_PREVIEW_SAMPLE_BYTES - 1}`,
      },
    ]);
    expect(document.querySelector("iframe")).toBeNull();
  });
});

it("retains thread host-files for absolute dot-assets inside a native storage popup", async () => {
  const target = nativeTargets[1]!;
  const assetRoute = `${prefix}/threads/${threadId}/host-files/storage/${threadId}/.assets/absolute.png`;
  put(
    target.route,
    `![absolute native chart](/storage/${threadId}/.assets/absolute.png)`,
    "text/markdown",
  );
  put(assetRoute, "thread-host-dot-asset", "image/png");
  show(target);
  const image = await screen.findByRole("img", {
    name: "absolute native chart",
  });
  expect(await readRenderedResource(image, assetRoute)).toBe(
    "thread-host-dot-asset",
  );
  expect(requests.map(({ path }) => path)).toEqual([target.route, assetRoute]);
});
