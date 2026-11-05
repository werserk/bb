import { describe, expect, it } from "vitest";
import { resolveEmbeddedLocalFileTarget } from "./embedded-local-file-target";

const STORAGE_ROOT = "/home/me/.bb/thread-storage/thr_own";
const WORKSPACE_ROOT = "/home/me/work/repo";

function resolve(
  path: string,
  overrides: {
    environmentId?: string | null;
    storage?: string | null;
    workspace?: string | null;
  } = {},
) {
  return resolveEmbeddedLocalFileTarget({
    environmentId:
      overrides.environmentId === undefined ? "env_1" : overrides.environmentId,
    link: { lineRange: null, openTargetId: null, path },
    threadId: "thr_own",
    threadStorageRootPath:
      overrides.storage === undefined ? STORAGE_ROOT : overrides.storage,
    workspaceRootPath:
      overrides.workspace === undefined ? WORKSPACE_ROOT : overrides.workspace,
  });
}

describe("resolveEmbeddedLocalFileTarget", () => {
  it("opens a file in the embedded thread's own storage", () => {
    expect(resolve(`${STORAGE_ROOT}/shots/a1.png`)).toMatchObject({
      kind: "thread-storage",
      relativePath: "shots/a1.png",
      threadId: "thr_own",
    });
  });

  it("opens a file in another thread's storage next to it", () => {
    expect(
      resolve("/home/me/.bb/thread-storage/thr_abcd234567/report.html"),
    ).toMatchObject({
      kind: "thread-storage",
      relativePath: "report.html",
      threadId: "thr_abcd234567",
    });
  });

  it("opens a workspace file by its relative path", () => {
    expect(resolve(`${WORKSPACE_ROOT}/src/index.ts`)).toMatchObject({
      environmentId: "env_1",
      kind: "workspace",
      relativePath: "src/index.ts",
    });
  });

  it("keeps the line range of the link", () => {
    expect(
      resolveEmbeddedLocalFileTarget({
        environmentId: "env_1",
        link: {
          lineRange: { endLineNumber: 5, startLineNumber: 3 },
          openTargetId: null,
          path: `${WORKSPACE_ROOT}/a.ts`,
        },
        threadId: "thr_own",
        threadStorageRootPath: STORAGE_ROOT,
        workspaceRootPath: WORKSPACE_ROOT,
      }),
    ).toMatchObject({ lineRange: { endLineNumber: 5, startLineNumber: 3 } });
  });

  it("rejects traversal out of the storage root", () => {
    expect(resolve(`${STORAGE_ROOT}/../../../../etc/passwd`)).toEqual({
      kind: "unavailable",
      path: `${STORAGE_ROOT}/../../../../etc/passwd`,
    });
  });

  it("rejects traversal out of the sibling storage parent", () => {
    expect(
      resolve("/home/me/.bb/thread-storage/thr_abcd234567/../../config.json"),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rejects a sibling directory that only shares the storage prefix", () => {
    expect(
      resolve("/home/me/.bb/thread-storage-x/thr_own/a.png"),
    ).toMatchObject({ kind: "unavailable" });
    expect(resolve(`${WORKSPACE_ROOT}-other/a.ts`)).toMatchObject({
      kind: "unavailable",
    });
  });

  it.each([
    "/home/me/.bb/thread-storage/%2e%2e/f.png",
    "/home/me/.bb/thread-storage/x#y/f.png",
    "/home/me/.bb/thread-storage/x?y/f.png",
    "/home/me/.bb/thread-storage/x\\y/f.png",
    "/home/me/.bb/thread-storage/thr_a b/f.png",
    "/home/me/.bb/thread-storage/notathread/f.png",
  ])("rejects a sibling segment that is not a thread id: %s", (path) => {
    expect(resolve(path)).toMatchObject({ kind: "unavailable" });
  });

  it("makes no sibling target when the storage parent is not thread-storage", () => {
    expect(resolve("/etc/passwd", { storage: "/thr_own" })).toMatchObject({
      kind: "unavailable",
    });
    expect(
      resolve("/home/me/other/thr_x/a.png", {
        storage: "/home/me/other/thr_own",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rejects the storage parent itself and a bare thread directory", () => {
    expect(resolve("/home/me/.bb/thread-storage")).toMatchObject({
      kind: "unavailable",
    });
    expect(resolve("/home/me/.bb/thread-storage/thr_abcd234567")).toMatchObject(
      {
        kind: "unavailable",
      },
    );
  });

  it("rejects paths outside every served root", () => {
    expect(resolve("/etc/passwd")).toEqual({
      kind: "unavailable",
      path: "/etc/passwd",
    });
    expect(resolve("/home/me/.ssh/id_ed25519")).toMatchObject({
      kind: "unavailable",
    });
  });

  it("is unavailable when the storage root and workspace are unknown", () => {
    expect(
      resolve(`${STORAGE_ROOT}/a.png`, { storage: null, workspace: null }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("does not serve workspace paths without an environment", () => {
    expect(
      resolve(`${WORKSPACE_ROOT}/a.ts`, { environmentId: null }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("handles Windows-style storage roots", () => {
    expect(
      resolve("C:\\Users\\me\\.bb\\thread-storage\\thr_own\\a.png", {
        storage: "C:\\Users\\me\\.bb\\thread-storage\\thr_own",
      }),
    ).toMatchObject({ kind: "thread-storage", relativePath: "a.png" });
    expect(
      resolve("D:\\other\\a.png", {
        storage: "C:\\Users\\me\\.bb\\thread-storage\\thr_own",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("resolves a Windows-style sibling thread storage link", () => {
    expect(
      resolve("C:\\Users\\me\\.bb\\thread-storage\\thr_abcd234567\\a.png", {
        storage: "C:\\Users\\me\\.bb\\thread-storage\\thr_own",
      }),
    ).toMatchObject({
      kind: "thread-storage",
      relativePath: "a.png",
      threadId: "thr_abcd234567",
    });
  });

  it("leaves app routes to normal navigation", () => {
    expect(resolve("/projects/proj_abc/threads/thr_abc")).toEqual({
      kind: "app-route",
    });
  });

  it("rejects relative and empty paths", () => {
    expect(resolve("relative/a.png")).toMatchObject({ kind: "unavailable" });
    expect(resolve("")).toMatchObject({ kind: "unavailable" });
  });
});
