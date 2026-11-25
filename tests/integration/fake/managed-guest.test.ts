import { expect, it, afterEach } from "vitest";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { HOST_AUTH_FILE_NAME } from "@bb/host-daemon-contract";
import { enrollmentDigest } from "../../../apps/host-daemon/src/managed-guest/enrollment.js";
import {
  openPinnedGuest,
  type SyntheticResident,
} from "../../../apps/host-daemon/src/managed-guest/journal.js";
import {
  initializeFixture,
  ingress,
  frame,
  observeProcess,
  ordinary,
  start,
  transfer,
  stop,
} from "../helpers/managed-guest-fixture.js";

const roots: string[] = [];
async function fixture() {
  const f = await initializeFixture();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const cannotRun: SyntheticResident = {
  inspect: async () => {},
  observe: () => observeProcess(process.pid),
  countInput() {
    throw new Error("Unexpected input effect");
  },
  interrupt() {
    throw new Error("Unexpected interrupt");
  },
};
async function protectedReceiver(
  f: Awaited<ReturnType<typeof fixture>>,
  resident = cannotRun,
  connection = ingress,
) {
  const opened = await openPinnedGuest(f.root, f.pin, connection, resident);
  if (opened.kind !== "protected")
    throw new Error("Expected a protected receiver");
  return opened.journal;
}
it("requires a trusted pin independent of the mutable enrollment; a separately pinned ordinary enrollment stays ordinary", async () => {
  const f = await fixture();
  const file = join(f.root, HOST_AUTH_FILE_NAME);
  const receiver = await protectedReceiver(f);
  try {
    await expect(
      receiver.receive(frame({ type: "thread.start" })),
    ).rejects.toThrow();
    const wrongFence = start();
    wrongFence.epoch.fence++;
    expect(await receiver.receive(frame(wrongFence))).toBe("unavailable");
    for (const cmd of [
      {
        ...start(),
        binding: { ...f.descriptor.binding, generation: "obsolete" },
      },
      {
        ...start(),
        binding: {
          ...f.descriptor.binding,
          workspace: { ...f.descriptor.binding.workspace, revision: 2 },
        },
      },
      { ...start(), runtimeRootKey: "other" },
    ])
      expect(await receiver.receive(frame(cmd))).toBe("unavailable");
  } finally {
    receiver.close();
  }
  await expect(
    protectedReceiver(f, cannotRun, { ...ingress, protocolVersion: 270 }),
  ).rejects.toThrow();
  await expect(
    protectedReceiver(f, cannotRun, { ...ingress, hostId: "another" }),
  ).rejects.toThrow();
  await rm(file);
  await expect(protectedReceiver(f)).rejects.toThrow();
  for (const raw of [
    "{",
    JSON.stringify({ ...ordinary, managedGuest: {} }),
    JSON.stringify({
      ...ordinary,
      managedGuest: { ...f.descriptor, profile: "old" },
    }),
    JSON.stringify(ordinary),
    JSON.stringify({ ...ordinary, hostType: "persistent" }),
  ]) {
    await writeFile(file, raw, { mode: 0o600 });
    await expect(protectedReceiver(f)).rejects.toThrow();
  }
  const ordinaryPin = {
    hostId: ingress.hostId,
    descriptorDigest: enrollmentDigest(ingress.hostId, null),
  };
  expect(
    await openPinnedGuest(f.root, ordinaryPin, ingress, cannotRun),
  ).toEqual({ kind: "ordinary" });
});
it("native startup refuses tagged protected enrollment before contacting a server", async () => {
  const f = await fixture();
  const script = `import {startHostDaemon} from "./apps/host-daemon/src/start-host-daemon.ts";
    try { await startHostDaemon(); process.exit(10); }
    catch(e) { if(e.message.includes("Protected guest enrollment requires")) process.exit(0);
    process.exit(11); }`;
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 20000,
      env: {
        HOME: f.root,
        PATH: process.env.PATH,
        BB_DATA_DIR: f.root,
        TMPDIR: f.root,
        BB_SERVER_URL: "http://127.0.0.1:1",
        BB_HOST_DAEMON_PORT: "49163",
        TSX_DISABLE_CACHE: "1",
      },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr.slice(-1200)).toBe(0);
});
it("refuses journal deletion, replacement, and in-place empty or wrong journal; never creates a journal at startup", async () => {
  const f = await fixture();
  await rename(f.path, f.path + ".saved");
  await expect(protectedReceiver(f)).rejects.toThrow();
  expect(existsSync(f.path)).toBe(false);
  await writeFile(f.path, "", { mode: 0o600 });
  await expect(protectedReceiver(f)).rejects.toThrow();
  await rename(f.path + ".saved", f.path);
  const db = new DatabaseSync(f.path);
  try {
    db.exec("UPDATE guest SET journal_id='changed'");
  } finally {
    db.close();
  }
  await expect(protectedReceiver(f)).rejects.toThrow();
  await writeFile(f.path, "");
  await expect(protectedReceiver(f)).rejects.toThrow();
});
it.each([false, true])(
  "holds unknown through a real receiver crash and fresh frame (effect before crash=%s)",
  async (after) => {
    const f = await fixture();
    const command = start();
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../helpers/managed-guest-crash.ts", import.meta.url),
        ),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: f.root,
          TMPDIR: f.root,
          TSX_DISABLE_CACHE: "1",
        },
        input: JSON.stringify({ root: f.root, pin: f.pin, command, after }),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal, result.stderr.slice(-1500)).toBe("SIGKILL");
    const sessionId = "reopened";
    const receiver = await protectedReceiver(f, cannotRun, {
      ...ingress,
      sessionId,
    });
    try {
      const replay = frame(command, sessionId);
      expect(await receiver.receive(replay)).toBe("unknown");
      const detached = await protectedReceiver(
        f,
        {
          ...cannotRun,
          async inspect() {
            throw new Error("Resident absent");
          },
          observe() {
            return null;
          },
        },
        { ...ingress, sessionId },
      );
      try {
        expect(await detached.receive(frame(command, sessionId))).toBe(
          "unknown",
        );
      } finally {
        detached.close();
      }
      expect(
        await receiver.receive(
          frame({ ...command, inputText: "changed" }, sessionId),
        ),
      ).toBe("conflict");
      expect(await receiver.receive(frame(start(), sessionId))).toBe("stale");
      expect(receiver.receipt(command.commandId)?.session).toBe(
        ingress.sessionId,
      );
      const path = join(f.root, "effects");
      console.info("receiver recovery", {
        signal: result.signal,
        originalSession: receiver.receipt(command.commandId)?.session,
        disposition: receiver.receipt(command.commandId)?.disposition,
        markers: existsSync(path)
          ? (await readFile(path, "utf8")).trim().split("\n").length
          : 0,
      });
      expect(existsSync(path) ? await readFile(path, "utf8") : "").toBe(
        after ? "input\n" : "",
      );
    } finally {
      receiver.close();
    }
  },
);
it("orders an awaiting Stop(A) against transfer to B on the same live child, then holds a winning Stop(B) against transfer", async () => {
  const f = await fixture();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    let signals=0;
    process.on('SIGUSR2',()=>{++signals;process.send(signals)});
    process.on('message',()=>process.send(signals));
    process.send('ready');
  `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} },
  );
  const exit = once(child, "exit");
  const blockers: (() => void)[] = [];
  const journals: Awaited<ReturnType<typeof protectedReceiver>>[] = [];
  try {
    expect((await once(child, "message"))[0]).toBe("ready");
    const holder = observeProcess(child.pid!);
    let count = 0;
    const resident: SyntheticResident = {
      async inspect() {},
      observe: () => observeProcess(child.pid!),
      countInput() {
        count++;
      },
      interrupt() {
        if (!child.kill("SIGUSR2")) throw new Error("Lost tracked child");
      },
    };
    const fast = await protectedReceiver(f, resident);
    journals.push(fast);
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = await protectedReceiver(f, {
      ...resident,
      async inspect() {
        expect(fast.receipt(a.commandId)?.disposition).toBe("applied");
        expect(observeProcess(child.pid!)).toEqual(holder);
        entered();
        await new Promise<void>((resolve) => blockers.push(resolve));
      },
    });
    journals.push(slow);
    const a = start(),
      b = transfer(a, "3");
    expect(await fast.receive(frame(a))).toBe("applied");
    const staleStop = stop(a);
    const pending = slow.receive(frame(staleStop));
    await paused;
    expect(await fast.receive(frame(b))).toBe("applied");
    blockers.pop()!();
    expect(await pending).toBe("stale");
    expect(await fast.receive(frame(staleStop))).toBe("stale");
    expect(observeProcess(child.pid!)).toEqual(holder);
    const probe = once(child, "message");
    child.send("count");
    expect((await probe)[0]).toBe(0);
    const changedConnection = { ...ingress, sessionId: "other-session" };
    const other = await protectedReceiver(f, resident, changedConnection);
    journals.push(other);
    expect(
      await other.receive(frame(stop(b), changedConnection.sessionId)),
    ).toBe("stale");
    const stopB = stop(b);
    const signal = once(child, "message");
    expect(await fast.receive(frame(stopB))).toBe("interrupt_requested");
    expect((await signal)[0]).toBe(1);
    expect(await fast.receive(frame(stopB))).toBe("interrupt_requested");
    expect(await fast.receive(frame(transfer(b, "4")))).toBe("unknown");
    expect(await fast.receive(frame(b))).toBe("applied");
    const last = once(child, "message");
    child.send("count");
    expect((await last)[0]).toBe(1);
    expect(count).toBe(2);
    expect(fast.receipt(a.commandId)?.fence).toBe(
      fast.receipt(b.commandId)?.fence,
    );
    expect(fast.receipt(b.commandId)?.revision).toBe(2);
    expect(child.exitCode).toBeNull();
    console.info("same resident", {
      pid: holder.pid,
      fence: b.epoch.fence,
      revision: b.epoch.transferRevision,
      inputs: count,
      staleStopSignals: 0,
      winningStopSignals: 1,
      transferredAfterWinningStop: false,
    });
  } finally {
    for (const unblock of blockers) unblock();
    for (const j of journals) j.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exit;
  }
});
