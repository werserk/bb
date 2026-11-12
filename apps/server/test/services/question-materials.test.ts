import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HostDaemonOnlineRpcRequestMessage,
  HostDaemonOnlineRpcResultByType,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { prepareQuestionMaterials } from "../../src/services/threads/question-materials.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

type Command = HostDaemonOnlineRpcRequestMessage["command"];
type Handler<K extends "host.read_file_chunk" | "host.write_file"> = (
  command: Extract<Command, { type: K }>,
) => Promise<HostDaemonOnlineRpcResultByType[K]>;
const handlersPath = fileURLToPath(
  new URL("../../../host-daemon/src/command-handlers/", import.meta.url),
);
const { readHostFileChunk } = (await import(
  path.join(handlersPath, "host-files.ts")
)) as { readHostFileChunk: Handler<"host.read_file_chunk"> };
const { writeHostFile } = (await import(
  path.join(handlersPath, "file-write.ts")
)) as { writeHostFile: Handler<"host.write_file"> };

async function withFiles(
  run: (context: {
    root: string;
    prepare: (
      materials: { path: string; label: string; dependencies: string[] }[],
      questionId?: string,
    ) => ReturnType<typeof prepareQuestionMaterials>;
    commands: Command[];
    beforeRead: {
      current:
        | ((
            command: Extract<Command, { type: "host.read_file_chunk" }>,
          ) => Promise<void>)
        | null;
    };
  }) => Promise<void>,
) {
  await withTestHarness(async (harness) => {
    const { host, session, thread } = seedThreadFixture(harness);
    const root = path.join(session.dataDir, "thread-storage", thread.id);
    await fs.mkdir(root, { recursive: true });
    const commands: Command[] = [];
    const beforeRead: {
      current:
        | ((
            command: Extract<Command, { type: "host.read_file_chunk" }>,
          ) => Promise<void>)
        | null;
    } = { current: null };
    registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      async handle({ command }) {
        commands.push(command);
        if (command.type === "host.read_file_chunk") {
          await beforeRead.current?.(command);
          return { ok: true, result: await readHostFileChunk(command) };
        }
        if (command.type === "host.write_file")
          return { ok: true, result: await writeHostFile(command) };
        throw new Error(`Unexpected ${command.type}`);
      },
    });
    try {
      await run({
        root,
        commands,
        beforeRead,
        prepare: (materials, questionId = "q_test") =>
          prepareQuestionMaterials(harness.deps, {
            threadId: thread.id,
            questionId,
            materials,
          }),
      });
    } finally {
      await fs.rm(session.dataDir, { recursive: true, force: true });
    }
  });
}
const material = (file: string, dependencies: string[] = []) => ({
  path: file,
  label: file,
  dependencies,
});

describe("question material snapshots", () => {
  it("freezes HTML and deduplicated relative assets without modifying originals", async () => {
    await withFiles(async ({ root, prepare, commands }) => {
      await fs.mkdir(path.join(root, "report/assets"), { recursive: true });
      await fs.writeFile(
        path.join(root, "report/index.html"),
        '<img src="assets/a.svg">',
      );
      await fs.writeFile(path.join(root, "report/assets/a.svg"), "<svg/>");
      const result = await prepare([
        material("report/index.html", [
          "report/assets/a.svg",
          "report/assets/a.svg",
        ]),
      ]);
      expect(result.hostId).toEqual(expect.any(String));
      expect(result.storageRootPath).toBe(root);
      expect(result.files).toHaveLength(2);
      expect(result.materials[0]).toMatchObject({
        originalPath: "report/index.html",
        snapshotPath: "question-materials/q_test/report/index.html",
        mimeType: "text/html",
        dependencies: ["question-materials/q_test/report/assets/a.svg"],
      });
      for (const file of result.files) {
        const original = await fs.readFile(path.join(root, file.originalPath));
        expect(await fs.readFile(path.join(root, file.snapshotPath))).toEqual(
          original,
        );
        expect(file.sha256).toBe(
          createHash("sha256").update(original).digest("hex"),
        );
        expect(file.sizeBytes).toBe(original.length);
      }
      expect(commands.filter((c) => c.type === "host.write_file")).toHaveLength(
        2,
      );
      await expect(
        prepare([material("report/index.html", ["report/assets/a.svg"])]),
      ).resolves.toEqual(result);
    });
  });
  it("prepares no host provenance for an empty material list", async () => {
    await withFiles(async ({ prepare, commands }) => {
      await expect(prepare([])).resolves.toEqual({
        hostId: null,
        storageRootPath: null,
        materials: [],
        files: [],
      });
      expect(commands).toHaveLength(0);
    });
  });
  it("snapshots five independent MP3 byte buffers exactly", async () => {
    await withFiles(async ({ root, prepare }) => {
      const inputs = Array.from({ length: 5 }, (_, i) =>
        material(`clip${i}.mp3`),
      );
      for (const [i, input] of inputs.entries())
        await fs.writeFile(
          path.join(root, input.path),
          Buffer.from([73, 68, 51, i, 255]),
        );
      const result = await prepare(inputs);
      expect(result.files).toHaveLength(5);
      for (const [i, file] of result.files.entries())
        expect(await fs.readFile(path.join(root, file.snapshotPath))).toEqual(
          Buffer.from([73, 68, 51, i, 255]),
        );
    });
  });
  it("rejects missing files before writing any snapshots", async () => {
    await withFiles(async ({ root, prepare, commands }) => {
      await fs.writeFile(path.join(root, "ok.md"), "ok");
      await expect(
        prepare([material("ok.md"), material("missing.mp3")]),
      ).rejects.toThrow(/does not exist|missing/i);
      expect(commands.filter((c) => c.type === "host.write_file")).toHaveLength(
        0,
      );
    });
  });
  it("rejects changes between real chunk reads", async () => {
    await withFiles(async ({ root, prepare, beforeRead, commands }) => {
      const file = path.join(root, "large.mp3");
      await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 10, 1));
      beforeRead.current = async (command) => {
        if (command.offset > 0) await fs.appendFile(file, "changed");
      };
      await expect(prepare([material("large.mp3")])).rejects.toThrow(
        /changed/i,
      );
      expect(commands.filter((c) => c.type === "host.write_file")).toHaveLength(
        0,
      );
    });
  });
  it("rejects traversal and symlinks escaping the storage root", async () => {
    await withFiles(async ({ root, prepare }) => {
      await expect(prepare([material("../outside.md")])).rejects.toThrow(
        /relative|contained|path/i,
      );
      await fs.symlink("/etc/passwd", path.join(root, "escape.md"));
      await expect(prepare([material("escape.md")])).rejects.toThrow(
        /escape|outside|root/i,
      );
      await fs.writeFile(path.join(root, "ok.md"), "ok");
      await expect(prepare([material("ok.md")], "../outside")).rejects.toThrow(
        /question.*id/i,
      );
    });
  });
  it("rejects snapshot writes through a symlink escaping the root", async () => {
    await withFiles(async ({ root, prepare }) => {
      await fs.writeFile(path.join(root, "ok.md"), "original");
      await fs.symlink("/etc", path.join(root, "question-materials"));
      await expect(prepare([material("ok.md")])).rejects.toThrow(
        /escape|outside|root/i,
      );
      expect(await fs.readFile(path.join(root, "ok.md"), "utf8")).toBe(
        "original",
      );
    });
  });
  it("rejects more than 64 MiB of declared files before any write", async () => {
    await withFiles(async ({ root, prepare, commands }) => {
      const inputs = Array.from({ length: 9 }, (_, i) =>
        material(`part${i}.mp3`),
      );
      for (const [i, input] of inputs.entries()) {
        const file = path.join(root, input.path);
        await fs.writeFile(file, "");
        await fs.truncate(file, i < 8 ? 8 * 1024 * 1024 : 1);
      }
      await expect(prepare(inputs)).rejects.toThrow(/64 MiB/i);
      expect(commands.filter((c) => c.type === "host.write_file")).toHaveLength(
        0,
      );
    });
  });
  it("refuses a conflicting snapshot and leaves it intact", async () => {
    await withFiles(async ({ root, prepare }) => {
      await fs.writeFile(
        path.join(root, "clip.mp3"),
        Buffer.from([73, 68, 51, 0, 1]),
      );
      await prepare([material("clip.mp3")]);
      await fs.writeFile(path.join(root, "clip.mp3"), "different");
      await expect(prepare([material("clip.mp3")])).rejects.toThrow(
        /snapshot.*conflict|different.*snapshot/i,
      );
      expect(
        await fs.readFile(
          path.join(root, "question-materials/q_test/clip.mp3"),
        ),
      ).toEqual(Buffer.from([73, 68, 51, 0, 1]));
    });
  });
  it("rejects unsupported main files and bounded RPC sizes", async () => {
    await withFiles(async ({ root, prepare }) => {
      await fs.writeFile(path.join(root, "archive.zip"), "zip");
      await expect(prepare([material("archive.zip")])).rejects.toThrow(
        /unsupported/i,
      );
      await fs.writeFile(
        path.join(root, "huge.mp3"),
        Buffer.alloc(8 * 1024 * 1024 + 1),
      );
      await expect(prepare([material("huge.mp3")])).rejects.toThrow(/8 MiB/i);
      await expect(
        prepare([
          material(
            "index.html",
            Array.from({ length: 128 }, (_, i) => `asset${i}.png`),
          ),
        ]),
      ).rejects.toThrow(/128/i);
    });
  });
});
