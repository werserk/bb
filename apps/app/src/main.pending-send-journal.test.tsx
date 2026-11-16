// @vitest-environment jsdom
import * as workerThreads from "node:worker_threads";
import { act, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { makeSystemConfig } from "./test/fixtures/system-config";

const nativeLocks =
  "locks" in workerThreads ? (workerThreads.locks as LockManager) : undefined;

const roots = vi.hoisted(() => [] as import("react-dom/client").Root[]);
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

it.skipIf(!nativeLocks)(
  "initializes signed-out recovery through the app entry with native Web Locks",
  async () => {
    const config = makeSystemConfig();
    const requests: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url.pathname);
      if (
        url.pathname === "/api/v1/plugins/bb-account/rpc/bb-account.v1.status"
      )
        return Response.json({
          ok: true,
          result: { state: "signed-out", revision: 0, account: null },
        });
      if (url.pathname === "/api/v1/system/config")
        return Response.json(config);
      return Response.json({ error: "offline fixture" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("CSS", { supports: () => false });
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: nativeLocks,
    });
    window.sessionStorage.clear();
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import("./main");
    });
    const { appQueryClient } = await import("./lib/app-query-client");
    const { pendingSendJournal, pendingSendIdentityUnavailable } =
      await import("./hooks/cache-owners/pending-send-owner");
    const key = `bb-pending-send/${JSON.stringify([
      window.location.origin,
      config.primaryHostId,
      config.dataDir,
      "signed-out",
    ])}`;
    try {
      await waitFor(() => {
        expect(requests).toContain("/api/v1/system/config");
        expect(pendingSendIdentityUnavailable(appQueryClient)).toBe(false);
        expect(window.sessionStorage.getItem(key)).not.toBeNull();
        expect(pendingSendJournal(appQueryClient)?.status).toBe("owned");
      });
      expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({
        version: 1,
        journalId: expect.any(String),
        entries: [],
      });
      expect((await nativeLocks!.query()).held).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.stringContaining(key) }),
        ]),
      );
    } finally {
      await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
      });
      const { wsManager } = await import("./lib/ws");
      wsManager.disconnect();
      pendingSendJournal(appQueryClient)?.dispose();
      appQueryClient.clear();
      window.sessionStorage.removeItem(key);
      if (originalLocks)
        Object.defineProperty(navigator, "locks", originalLocks);
      else Reflect.deleteProperty(navigator, "locks");
      vi.unstubAllGlobals();
    }
  },
  30_000,
);
