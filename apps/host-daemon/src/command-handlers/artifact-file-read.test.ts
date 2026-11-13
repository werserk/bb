import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "@bb/test-helpers";
import { readHostFileChunk } from "./host-files.js";

afterEach(() => vi.restoreAllMocks());
it("keeps native bytes while refusing scoped oversized, secret, symlink and unsupported bytes", async () => {
  const rootPath = await makeTempDir("artifact-read-");
  await fs.mkdir(path.join(rootPath, ".assets"));
  const files = {
    "report.md": "x".repeat(1_000_001),
    "report.html": "x".repeat(3_000_000),
    ".assets/x.png": "png",
    ".env": "secret",
    "good.md": "ok",
    "font.woff": "font",
  };
  for (const [name, body] of Object.entries(files))
    await fs.writeFile(path.join(rootPath, name), body);
  await fs.symlink(path.join(rootPath, ".env"), path.join(rootPath, "a.png"));
  const read = (name: string, strict: boolean) =>
    readHostFileChunk({
      type: "host.read_file_chunk",
      path: path.join(rootPath, name),
      rootPath,
      offset: 0,
      length: 20,
      revision: null,
      ...(strict ? { artifactPolicy: "artifact-v1" as const } : {}),
    });
  for (const name of [...Object.keys(files), "a.png"]) {
    expect((await read(name, false)).sizeBytes).toBeGreaterThan(0);
    if (name === "good.md")
      expect(
        Buffer.from((await read(name, true)).content, "base64").toString(),
      ).toBe("ok");
    else await expect(read(name, true)).rejects.toThrow();
  }
});
it("refuses parent replacement between resolution and open", async () => {
  const rootPath = await makeTempDir("artifact-race-");
  const outside = await makeTempDir("artifact-outside-");
  await fs.mkdir(path.join(rootPath, "parent"));
  await fs.writeFile(path.join(rootPath, "parent/good.md"), "safe");
  await fs.writeFile(path.join(outside, "good.md"), "secret");
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    await fs.rename(path.join(rootPath, "parent"), path.join(rootPath, "old"));
    await fs.symlink(outside, path.join(rootPath, "parent"));
    return open(...args);
  });
  await expect(
    readHostFileChunk({
      type: "host.read_file_chunk",
      path: path.join(rootPath, "parent/good.md"),
      rootPath,
      offset: 0,
      length: 20,
      revision: null,
      artifactPolicy: "artifact-v1",
    }),
  ).rejects.toThrow();
});

it("pins the same denial fixtures as Library", async () => {
  const { createHash } = await import("node:crypto");
  const { artifactDeniedName } = await import("./file-read.js");
  const bytes = await fs.readFile(
    new URL(
      "../../../../packages/host-daemon-contract/fixtures/artifact-denied.json",
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "84a97c0503d6852bbdf1ef7c14b4fa9967e4c9a8b6c53b2d8c20fb544a779bb9",
  );
  for (const [name, denied] of JSON.parse(bytes.toString()))
    expect(artifactDeniedName(name)).toBe(denied);
});

it("preserves protocol 260 compatibility by refusing the optional field on old strict readers", async () => {
  const { z } = await import("zod");
  const legacy = z.object({type:z.literal("host.read_file_chunk"),path:z.string(),rootPath:z.string(),offset:z.number(),length:z.number(),revision:z.string().nullable()}).strict();
  const command={type:"host.read_file_chunk",path:"/root/a.md",rootPath:"/root",offset:0,length:10,revision:null};
  expect(legacy.safeParse(command).success).toBe(true);
  expect(legacy.safeParse({...command,artifactPolicy:"artifact-v1"}).success).toBe(false);
});

it("refuses FIFO without blocking for either policy", async () => {
  if (process.platform === "win32") return;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const rootPath = await makeTempDir("artifact-fifo-");
  const filePath = path.join(rootPath, "pipe.md");
  await promisify(execFile)("mkfifo", [filePath]);
  for (const strict of [false, true]) await expect(readHostFileChunk({ type: "host.read_file_chunk", path: filePath, rootPath, offset: 0, length: 20, revision: null, ...(strict ? { artifactPolicy: "artifact-v1" as const } : {}) })).rejects.toThrow("not a regular file");
});
