import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedEnvironment,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { DEFAULT_PATH_LIST_EXCLUDE_NAMES } from "../../src/routes/path-list-policy.js";

const DEFAULT_EXCLUDE_NAMES = [...DEFAULT_PATH_LIST_EXCLUDE_NAMES];

const WRITTEN_RESULT = {
  outcome: "written",
  sha256: "a".repeat(64),
  sizeBytes: 5,
} as const;

const READ_RESULT = {
  path: "/home/me/notes/note.md",
  content: "# Hi",
  contentEncoding: "utf8",
  mimeType: "text/markdown",
  modifiedAtMs: 1234,
  sha256: "b".repeat(64),
  sizeBytes: 4,
} as const;

function postJson(path: string, body: unknown): [string, RequestInit] {
  return [
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ];
}

describe("host file routes", () => {
  it("rejects hostile-origin and text/plain privileged mutations before host RPC", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const commands: HostDaemonOnlineRpcRequestMessage["command"][] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commands.push(request.command);
          return { ok: true, result: { ok: true } };
        },
      });

      const mutations = [
        ["/api/v1/files/write", { path: "/notes/a.md", content: "attacker" }],
        ["/api/v1/files/mkdir", { path: "/notes/private" }],
        [
          "/api/v1/files/move",
          {
            sourcePath: "/notes/a.md",
            destinationPath: "/notes/b.md",
          },
        ],
        ["/api/v1/files/remove", { path: "/notes/b.md" }],
      ] as const;

      for (const [route, payload] of mutations) {
        const hostile = await harness.app.request(route, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
          body: JSON.stringify(payload),
        });
        expect(hostile.status, route).toBe(403);

        const simpleRequest = await harness.app.request(route, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify(payload),
        });
        expect(simpleRequest.status, route).toBe(415);
      }

      expect(commands).toEqual([]);
    });
  });

  it("streams preview files, revalidating media while keeping sandboxed HTML uncached", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const revision = "d".repeat(64);
      const files = new Map([
        [
          "/notes/chart.png",
          {
            bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            mimeType: "image/png",
          },
        ],
        [
          "/notes/report.html",
          {
            bytes: Buffer.from("<!doctype html><h1>Report</h1>"),
            mimeType: "text/html",
          },
        ],
        [
          "/notes/archive.zip",
          {
            bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]),
            mimeType: "application/zip",
          },
        ],
      ]);
      const rootPaths: string[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type !== "host.read_file_chunk")
            throw new Error("Unexpected command");
          rootPaths.push(command.rootPath);
          const file = files.get(command.path);
          if (!file) throw new Error(`Unexpected path ${command.path}`);
          return {
            ok: true,
            result: {
              path: command.path,
              content: file.bytes
                .subarray(command.offset, command.offset + command.length)
                .toString("base64"),
              offset: command.offset,
              mimeType: file.mimeType,
              modifiedAtMs: 1234,
              sizeBytes: file.bytes.length,
              revision,
            },
          };
        },
      });

      const leaseResponse = await harness.app.request(
        ...postJson("/api/v1/files/previews", { rootPath: "/notes" }),
      );
      expect(leaseResponse.status).toBe(200);
      const lease = await readJson(leaseResponse);
      expect(lease).toMatchObject({
        baseUrl: expect.stringMatching(/^\/api\/v1\/file-previews\//),
      });
      if (
        typeof lease !== "object" ||
        lease === null ||
        !("baseUrl" in lease) ||
        typeof lease.baseUrl !== "string"
      ) {
        throw new Error("Preview response missing baseUrl");
      }

      const image = await harness.app.request(`${lease.baseUrl}/chart.png`, {
        headers: { "if-none-match": `W/"file-${revision}"` },
      });
      expect(image.status).toBe(304);
      expect(image.headers.get("cache-control")).toBe("private, no-cache");

      const content = await harness.app.request(
        `${lease.baseUrl}/report.html`,
        { headers: { "if-none-match": `W/"file-${revision}"` } },
      );
      expect(content.status).toBe(200);
      expect(content.headers.get("cache-control")).toBe("no-store");
      expect(content.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(content.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(content.text()).resolves.toContain("<h1>Report</h1>");

      const archive = await harness.app.request(
        `${lease.baseUrl}/archive.zip`,
        { headers: { Range: "bytes=0-3" } },
      );
      expect(archive.status).toBe(206);
      expect(archive.headers.get("content-range")).toBe("bytes 0-3/8");
      expect(Buffer.from(await archive.arrayBuffer())).toEqual(
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      );
      expect(new Set(rootPaths)).toEqual(new Set(["/notes"]));
    });
  });

  it("routes recursive path listings and confined mutations to the selected daemon", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const commands: HostDaemonOnlineRpcRequestMessage["command"][] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commands.push(request.command);
          if (request.command.type === "host.list_paths") {
            return { ok: true, result: { paths: [], truncated: false } };
          }
          if (request.command.type === "host.list_files") {
            return { ok: true, result: { files: [], truncated: false } };
          }
          return { ok: true, result: { ok: true } };
        },
      });

      for (const [route, payload] of [
        [
          "/api/v1/files/paths",
          { path: "/notes", includeFiles: true, includeDirectories: true },
        ],
        [
          "/api/v1/files/paths",
          {
            path: "/notes",
            includeFiles: true,
            includeDirectories: true,
            includeHidden: false,
          },
        ],
        [
          "/api/v1/files/list",
          { path: "/notes", includeHidden: false, excludeNames: [".obsidian"] },
        ],
        [
          "/api/v1/files/mkdir",
          { path: "/notes/projects", rootPath: "/notes" },
        ],
        [
          "/api/v1/files/move",
          {
            sourcePath: "/notes/a.md",
            destinationPath: "/notes/b.md",
            rootPath: "/notes",
          },
        ],
        ["/api/v1/files/remove", { path: "/notes/b.md", rootPath: "/notes" }],
      ] as const) {
        const response = await harness.app.request(...postJson(route, payload));
        expect(
          response.status,
          `${route}: ${await response.clone().text()}`,
        ).toBe(200);
      }

      expect(commands).toEqual([
        {
          type: "host.list_paths",
          path: "/notes",
          limit: 1000,
          includeFiles: true,
          includeDirectories: true,
          includeHidden: true,
          respectGitIgnore: false,
          excludeNames: DEFAULT_EXCLUDE_NAMES,
        },
        {
          type: "host.list_paths",
          path: "/notes",
          limit: 1000,
          includeFiles: true,
          includeDirectories: true,
          includeHidden: false,
          respectGitIgnore: false,
          excludeNames: DEFAULT_EXCLUDE_NAMES,
        },
        {
          type: "host.list_files",
          followRootSymlink: false,
          path: "/notes",
          limit: 1000,
          includeHidden: false,
          respectGitIgnore: false,
          excludeNames: [".obsidian"],
        },
        {
          type: "host.mkdir",
          path: "/notes/projects",
          rootPath: "/notes",
          recursive: false,
        },
        {
          type: "host.move_path",
          sourcePath: "/notes/a.md",
          destinationPath: "/notes/b.md",
          rootPath: "/notes",
        },
        {
          type: "host.remove_path",
          path: "/notes/b.md",
          rootPath: "/notes",
          recursive: false,
        },
      ]);
    });
  });

  it("fills write defaults and resolves the primary host at the boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const requests: HostDaemonOnlineRpcRequestMessage[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          requests.push(request);
          if (request.command.type !== "host.write_file") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          return { ok: true, result: WRITTEN_RESULT };
        },
      });

      const response = await harness.app.request(
        ...postJson("/api/v1/files/write", {
          path: "/home/me/notes/note.md",
          content: "hello",
        }),
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual(WRITTEN_RESULT);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.command).toEqual({
        type: "host.write_file",
        path: "/home/me/notes/note.md",
        content: "hello",
        contentEncoding: "utf8",
        createParents: false,
      });
    });
  });

  it("passes the create-only null guard through to the daemon", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const commands: unknown[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          commands.push(request.command);
          return {
            ok: true,
            result: { outcome: "conflict", currentSha256: null },
          };
        },
      });

      const response = await harness.app.request(
        ...postJson("/api/v1/files/write", {
          hostId: host.id,
          path: "/home/me/notes/new.md",
          content: "hello",
          expectedSha256: null,
          createParents: true,
        }),
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        outcome: "conflict",
        currentSha256: null,
      });
      expect(commands[0]).toMatchObject({
        expectedSha256: null,
        createParents: true,
      });
    });
  });

  it("serves reads and remaps daemon ENOENT to 404", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.read_file") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          if (request.command.path === "/home/me/notes/note.md") {
            return { ok: true, result: READ_RESULT };
          }
          return {
            ok: false,
            errorCode: "ENOENT",
            errorMessage: "Path does not exist",
          };
        },
      });

      const okResponse = await harness.app.request(
        ...postJson("/api/v1/files/read", {
          hostId: host.id,
          path: "/home/me/notes/note.md",
          rootPath: "/home/me/notes",
        }),
      );
      expect(okResponse.status).toBe(200);
      expect(await readJson(okResponse)).toEqual(READ_RESULT);

      const missingResponse = await harness.app.request(
        ...postJson("/api/v1/files/read", {
          hostId: host.id,
          path: "/home/me/notes/missing.md",
        }),
      );
      expect(missingResponse.status).toBe(404);
    });
  });
});

it("acknowledges artifact policy and forwards it on every byte read while legacy stays unpoliced", async () => {
  await withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    const commands: HostDaemonOnlineRpcRequestMessage["command"][] = [];
    registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        commands.push(command);
        if (command.type !== "host.read_file_chunk")
          throw new Error("Unexpected command");
        return {
          ok: true,
          result: {
            path: command.path,
            offset: command.offset,
            sizeBytes: 2,
            modifiedAtMs: 1,
            mimeType: "text/markdown",
            revision: "a".repeat(64),
            content: Buffer.from("ok")
              .subarray(command.offset, command.offset + command.length)
              .toString("base64"),
          },
        };
      },
    });
    for (const policy of ["native", "artifact-v2", ""]) {
      expect(
        (
          await harness.app.request(
            ...postJson("/api/v1/files/previews", {
              rootPath: "/notes",
              policy,
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await harness.app.request(
          ...postJson("/api/v1/files/previews", {
            target: { kind: "thread-storage", threadId: "missing" },
          }),
        )
      ).status,
    ).toBe(400);
    for (const strict of [false, true]) {
      const response = await harness.app.request(
        ...postJson("/api/v1/files/previews", {
          rootPath: "/notes",
          ...(strict
            ? {
                policy: "artifact-v1",
                expectedSource: {
                  hostId: host.id,
                  canonicalReadRoot: "/notes",
                },
              }
            : {}),
        }),
      );
      const lease = await response.json();
      expect(lease.policy).toBe(strict ? "artifact-v1" : undefined);
      commands.length = 0;
      expect(
        await (await harness.app.request(`${lease.baseUrl}/report.md`)).text(),
      ).toBe("ok");
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command.type).toBe("host.read_file_chunk");
        expect(
          "artifactPolicy" in command ? command.artifactPolicy : undefined,
        ).toBe(strict ? "artifact-v1" : undefined);
      }
    }
  });
});

it("serves the real differential tree natively and refuses strict lease bytes", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const reader: unknown = await import(
    new URL(
      "../../../host-daemon/src/command-handlers/host-files.ts",
      import.meta.url,
    ).href
  );
  if (
    typeof reader !== "object" ||
    reader === null ||
    !("readHostFileChunk" in reader) ||
    typeof reader.readHostFileChunk !== "function"
  )
    throw new Error("Missing daemon reader fixture");
  const readHostFileChunk = reader.readHostFileChunk;
  const root = await fs.mkdtemp(join(tmpdir(), "artifact-lease-"));
  try {
    await fs.mkdir(join(root, ".assets"));
    const files = {
      "report.md": "x".repeat(2_000_000),
      "report.html": "x".repeat(3_000_000),
      ".assets/x.png": "png",
      ".env": "secret",
    };
    for (const [name, bytes] of Object.entries(files))
      await fs.writeFile(join(root, name), bytes);
    await fs.symlink(join(root, ".env"), join(root, "a.png"));
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async ({ command }) => {
          if (command.type !== "host.read_file_chunk")
            throw new Error("Unexpected command");
          try {
            return { ok: true, result: await readHostFileChunk(command) };
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              typeof error.code === "string"
            )
              return {
                ok: false,
                errorCode: error.code,
                errorMessage: error.message,
              };
            throw error;
          }
        },
      });
      const lease = await (
        await harness.app.request(
          ...postJson("/api/v1/files/previews", {
            rootPath: root,
            policy: "artifact-v1",
            expectedSource: { hostId: host.id, canonicalReadRoot: root },
          }),
        )
      ).json();
      for (const name of [...Object.keys(files), "a.png"]) {
        const native = await harness.app.request(
          `/api/v1/hosts/${host.id}/files/${root.slice(1)}/${name}`,
        );
        expect(native.status, name).toBe(200);
        expect((await native.arrayBuffer()).byteLength).toBeGreaterThan(0);
        const strict = await harness.app.request(`${lease.baseUrl}/${name}`);
        expect(strict.status, name).not.toBe(200);
        await strict.arrayBuffer();
      }
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("expires strict leases and refuses unknown descriptor roots before assigning source identity", async () => {
  await withTestHarness(async (harness) => {
    const { host } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);
    for (const root of [
      "/absolute",
      "../escape",
      "C:\\root",
      "nested/../secret",
      "\\\\server\\share",
    ]) {
      expect(
        (
          await harness.app.request(
            ...postJson("/api/v1/files/previews", {
              target: { kind: "workspace", environmentId: "missing", root },
              policy: "artifact-v1",
              expectedSource: { hostId: host.id, canonicalReadRoot: "/notes" },
            }),
          )
        ).status,
      ).toBe(400);
    }
    const lease = await (
      await harness.app.request(
        ...postJson("/api/v1/files/previews", {
          rootPath: "/notes",
          policy: "artifact-v1",
          expectedSource: { hostId: host.id, canonicalReadRoot: "/notes" },
          ttlMs: 60000,
        }),
      )
    ).json();
    const { vi } = await import("vitest");
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    try {
      expect(
        (await harness.app.request(`${lease.baseUrl}/report.md`)).status,
      ).toBe(404);
    } finally {
      time.mockRestore();
    }
    const renewed = await (
      await harness.app.request(
        ...postJson("/api/v1/files/previews", {
          rootPath: "/notes",
          policy: "artifact-v1",
          expectedSource: { hostId: host.id, canonicalReadRoot: "/notes" },
        }),
      )
    ).json();
    expect(renewed.policy).toBe("artifact-v1");
    expect(renewed.baseUrl).not.toBe(lease.baseUrl);
  });
});

it("pins original physical A while a fresh B descriptor returns zero B bytes", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const reader: unknown = await import(
    new URL(
      "../../../host-daemon/src/command-handlers/host-files.ts",
      import.meta.url,
    ).href
  );
  if (
    typeof reader !== "object" ||
    !reader ||
    !("readHostFileChunk" in reader) ||
    typeof reader.readHostFileChunk !== "function"
  )
    throw Error("Missing reader");
  const read = reader.readHostFileChunk;
  const dir = await fs.mkdtemp(join(tmpdir(), "artifact-source-"));
  const A = join(dir, "A"),
    B = join(dir, "B");
  try {
    await fs.mkdir(A);
    await fs.mkdir(B);
    await fs.writeFile(join(A, "report.md"), "original-A");
    await fs.writeFile(join(B, "report.md"), "forbidden-B");
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: A,
      });
      const returned: string[] = [];
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async ({ command }) => {
          if (command.type !== "host.read_file_chunk")
            throw Error("Unexpected command");
          expect(command.expectedCanonicalRoot).toBe(A);
          try {
            const result = await read(command);
            returned.push(Buffer.from(result.content, "base64").toString());
            return { ok: true, result };
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              typeof error.code === "string"
            )
              return {
                ok: false,
                errorCode: error.code,
                errorMessage: error.message,
              };
            throw error;
          }
        },
      });
      for (const [name, bytes] of Object.entries({
        "report.html": "<h1>Report</h1>",
        "script.js": "window.ready=true",
        "style.css": "body{color:green}",
        "image.svg": "<svg/>",
        ".env": "private",
        "big.html": "x".repeat(1_000_001),
      }))
        await fs.writeFile(join(A, name), bytes);
      await fs.mkdir(join(A, "folder"));
      const body = {
        target: { kind: "workspace", environmentId: environment.id, root: "" },
        policy: "artifact-v1",
        expectedSource: { hostId: host.id, canonicalReadRoot: A },
      };
      const first = await (
        await harness.app.request(...postJson("/api/v1/files/previews", body))
      ).json();
      for (const suffix of [
        "",
        "/",
        "/report.html",
        "/script.js",
        "/style.css",
        "/image.svg",
        "/folder",
        "/folder/",
        "/missing.html",
        "/.env",
        "/big.html",
        "/%00bad",
        "/%E0%A4%A",
      ]) {
        const response = await harness.app.request(first.baseUrl + suffix, {
          headers: { "if-none-match": "*" },
        });
        expect(response.status < 300 || response.status >= 400, suffix).toBe(
          true,
        );
        expect(response.headers.get("location"), suffix).toBeNull();
        await response.arrayBuffer();
      }
      const { environments } = await import("@bb/db");
      const { eq } = await import("drizzle-orm");
      harness.deps.db
        .update(environments)
        .set({ path: B })
        .where(eq(environments.id, environment.id))
        .run();
      const stale = await harness.app.request(first.baseUrl + "/report.md");
      expect(stale.status).toBe(200);
      expect(await stale.text()).toBe("original-A");
      returned.length = 0;
      const secondResponse = await harness.app.request(
        ...postJson("/api/v1/files/previews", body),
      );
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json();
      expect(second.expectedSource).toEqual(body.expectedSource);
      const substitute = await harness.app.request(
        second.baseUrl + "/report.md",
      );
      expect(substitute.status).not.toBe(200);
      expect(await substitute.text()).not.toContain("forbidden-B");
      expect(returned).toEqual([]);
      const mismatch = await harness.app.request(
        ...postJson("/api/v1/files/previews", {
          ...body,
          expectedSource: { ...body.expectedSource, hostId: "different" },
        }),
      );
      expect(mismatch.status).toBe(409);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
