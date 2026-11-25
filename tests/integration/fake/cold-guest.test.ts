import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { openPinnedGuest } from "../../../apps/host-daemon/src/managed-guest/journal.js";
import {
  initializeFixture,
  frame,
  start,
  ingress,
} from "../helpers/managed-guest-fixture.js";

it.each(["before", "after-create", "after-acceptance"])(
  "reopens cold creation killed at %s without creating twice",
  async (point) => {
    const f = await initializeFixture(),
      command = start();
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(
            new URL("../helpers/cold-guest-crash.ts", import.meta.url),
          ),
        ],
        {
          env: {
            HOME: f.root,
            TMPDIR: f.root,
            PATH: process.env.PATH,
            TSX_DISABLE_CACHE: "1",
          },
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          input: JSON.stringify({ ...f, frame: frame(command), point }),
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(run.signal, run.stderr).toBe("SIGKILL");
      const reopened = await openPinnedGuest(f.root, f.pin, ingress, {
        inspectEmpty: () => ({ physicalFence: 4 }),
        createSyntheticSession() {
          throw Error("Unexpected replay");
        },
      });
      if (reopened.kind !== "protected")
        throw Error("Missing protected receiver");
      try {
        const expected = point === "after-acceptance" ? "applied" : "unknown";
        expect(await reopened.journal.receive(frame(command))).toBe(expected);
        const marker = join(f.root, "count");
        const ids = existsSync(marker)
          ? readFileSync(marker, "utf8").trim().split("\n")
          : [];
        expect(ids.length).toBe(point === "before" ? 0 : 1);
        expect(reopened.journal.createdSession(command.commandId)).toBe(
          point === "after-acceptance" ? ids[0] : null,
        );
        expect(await reopened.journal.receive(frame(start()))).toBe("stale");
        expect(
          await reopened.journal.receive(
            frame({ ...command, inputText: "other" }),
          ),
        ).toBe("conflict");
      } finally {
        reopened.journal.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
