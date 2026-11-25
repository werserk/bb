import { canonicalJsonBytes, sha256Digest } from "@bb/domain";
import type { ManagedGuestEnrollment } from "@bb/host-daemon-contract";
import {
  decodeForProtectedGuest,
  type ManagedGuestCommand,
} from "@bb/host-daemon-contract/managed-guest-lab";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyPinnedEnrollment,
  type LocalEnrollmentPin,
} from "./enrollment.js";

export const journalFilename = "managed-guest.sqlite";
// Creation is reserved for the isolated fixture's enrollment step. Startup only opens an existing journal.
export const journalSchema = `
  PRAGMA user_version=1;
  CREATE TABLE guest (id INTEGER PRIMARY KEY CHECK(id=1), journal_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, current_command TEXT, phase TEXT NOT NULL DEFAULT 'empty',
    holder TEXT, provider_thread TEXT);
  CREATE TABLE effect (id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL, session TEXT NOT NULL,
    request TEXT NOT NULL, owner TEXT NOT NULL, fence INTEGER NOT NULL, revision INTEGER NOT NULL,
    thread TEXT NOT NULL, kind TEXT NOT NULL, disposition TEXT NOT NULL, claimed INTEGER NOT NULL CHECK(claimed IN (0,1)));
  CREATE TABLE created_session(command_id TEXT PRIMARY KEY REFERENCES effect(id), provider_thread TEXT NOT NULL UNIQUE);
  CREATE UNIQUE INDEX admitted_input ON effect(request) WHERE claimed=1 AND kind != 'managed.thread.stop';
`;

export interface SyntheticResidentObservation {
  physicalFence: number;
  bootId: string;
  pid: number;
  processStart: string;
  providerThreadId: string;
  idle: boolean;
}
// The only adapter in this slice is the isolated test resident. No paths or programs come from a frame.
export interface SyntheticResident {
  inspect(): Promise<void>;
  observe(): SyntheticResidentObservation | null;
  countInput(): void;
  interrupt(): void;
}
// Local supervisor owns the slot. It can create a synthetic session but cannot launch a provider.
export interface SyntheticColdSlot {
  inspectEmpty(): { physicalFence: number } | null;
  createSyntheticSession(): SyntheticResidentObservation;
}
type EffectReceipt = {
  claimed: number;
  id: string;
  digest: string;
  session: string;
  request: string;
  owner: string;
  fence: number;
  revision: number;
  thread: string;
  kind: string;
  disposition: string;
};
type GuestRow = {
  journal_id: string;
  revision: number;
  current_command: string | null;
  phase: string;
  holder: string | null;
  provider_thread: string | null;
};
type Disposition =
  | "applied"
  | "interrupt_requested"
  | "unknown"
  | "stale"
  | "conflict"
  | "unavailable";

export interface GuestConnection {
  readonly hostId: string;
  readonly sessionId: string;
  readonly protocolVersion: number;
}
export async function openPinnedGuest(
  dataDir: string,
  pin: LocalEnrollmentPin,
  connection: GuestConnection,
  resident: SyntheticResident | SyntheticColdSlot,
) {
  const enrollment = await classifyPinnedEnrollment(dataDir, pin);
  if (connection.hostId !== pin.hostId || !connection.sessionId)
    throw new Error("Guest connection identity unavailable");
  if (!enrollment) return { kind: "ordinary" as const };
  if (connection.protocolVersion !== 271)
    throw new Error("Guest connection is unqualified");
  const path = join(dataDir, journalFilename);
  const checkFile = () => {
    const dir = lstatSync(dataDir);
    if (
      !dir.isDirectory() ||
      dir.uid !== enrollment.uid ||
      (dir.mode & 0o077) !== 0
    )
      throw new Error("Guest journal directory is unqualified");
    const stat = lstatSync(path, { bigint: true });
    if (
      !stat.isFile() ||
      stat.ino.toString() !== enrollment.inode ||
      stat.dev.toString() !== enrollment.device ||
      stat.uid !== BigInt(enrollment.uid) ||
      (stat.mode & 0o077n) !== 0n
    )
      throw new Error("Guest journal identity unavailable");
  };
  checkFile();
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "rw");
  const db = new DatabaseSync(url.href);
  try {
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000");
    if (
      db.prepare("PRAGMA user_version").get()?.user_version !== 1 ||
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
    )
      throw new Error("Guest journal format unavailable");
    // Compile all effect columns at open, including for an unused worker.
    db.prepare(
      "SELECT id,digest,session,request,owner,fence,revision,thread,kind,disposition,claimed FROM effect LIMIT 0",
    ).all();
    if ("inspectEmpty" in resident)
      db.prepare(
        "SELECT command_id,provider_thread FROM created_session LIMIT 0",
      ).all();
    const journal = new GuestJournal(
      db,
      enrollment,
      checkFile,
      Object.freeze({ ...connection }),
      resident,
    );
    journal.validateCurrent();
    return { kind: "protected" as const, journal };
  } catch (error) {
    db.close();
    throw error;
  }
}

class GuestJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly enrollment: ManagedGuestEnrollment,
    private readonly checkFile: () => void,
    private readonly ingress: GuestConnection,
    private readonly resident: SyntheticResident | SyntheticColdSlot,
  ) {}
  close() {
    this.db.close();
  }
  private check(): GuestRow {
    this.checkFile();
    const row = this.db.prepare("SELECT * FROM guest WHERE id=1").get() as
      GuestRow | undefined;
    if (!row || row.journal_id !== this.enrollment.journalId)
      throw new Error("Guest journal unavailable");
    return row;
  }
  validateCurrent() {
    this.transaction(() => {
      const row = this.check();
      if (
        row.phase === "empty" &&
        row.revision === 0 &&
        row.current_command === null &&
        row.holder === null &&
        row.provider_thread === null &&
        !this.db.prepare("SELECT id FROM effect WHERE claimed=1 LIMIT 1").get()
      )
        return;
      const current = row.current_command
        ? this.receipt(row.current_command)
        : null;
      if (
        row.phase === "creating" &&
        row.revision === 1 &&
        row.provider_thread === null &&
        row.holder === null &&
        current?.kind === "managed.thread.start" &&
        current.claimed === 1 &&
        current.revision === 1 &&
        current.disposition === "unknown"
      )
        return;
      if (
        !current ||
        !row.holder ||
        !row.provider_thread ||
        !["resident", "pending", "stopping"].includes(row.phase) ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        current.revision !== row.revision ||
        current.kind === "managed.thread.stop" ||
        current.claimed !== 1 ||
        current.disposition !==
          (row.phase === "pending" ? "unknown" : "applied")
      )
        throw new Error("Guest journal custody unavailable");
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  receipt(commandId: string): EffectReceipt | null {
    return (
      (this.db.prepare("SELECT * FROM effect WHERE id=?").get(commandId) as
        EffectReceipt | undefined) ?? null
    );
  }
  async receive(frame: unknown): Promise<Disposition> {
    const { resident, ingress } = this;
    const { command } = decodeForProtectedGuest(frame, ingress);
    if (
      canonicalJsonBytes(command.binding) !==
      canonicalJsonBytes(this.enrollment.binding)
    )
      return "unavailable";
    if (
      command.type !== "managed.thread.stop" &&
      (command.runtimeRootKey !== this.enrollment.runtimeRootKey ||
        command.launchProfileId !== this.enrollment.launchProfileId)
    )
      return "unavailable";
    const digest = sha256Digest(canonicalJsonBytes(command));
    // A reopened observer can read the original outcome even when the resident has vanished.
    this.check();
    const prior = this.receipt(command.commandId);
    if (prior) return this.replay(prior, digest);
    if ("inspectEmpty" in resident) {
      if (command.type !== "managed.thread.start") return "unavailable";
      return this.createFirst(command, digest, resident);
    }
    // Preflight can suspend. All eligibility and holder comparisons follow it under the writer lock.
    try {
      await resident.inspect();
    } catch {
      return "unavailable";
    }
    const result = this.transaction(() =>
      this.claim(command, ingress.sessionId, digest, resident.observe()),
    );
    if (result !== "won") return result;
    // A committed pending/stopping phase blocks all transfers, including from other daemon instances.
    // Any failure after this point leaves the effect unknown. Never replay on open.
    const stop = command.type === "managed.thread.stop";
    if (stop) resident.interrupt();
    else resident.countInput();
    return this.transaction(() => {
      const guest = this.check();
      // Only this command can finish its claim. On Stop, the target retains ownership.
      if (
        guest.current_command !==
          (stop ? command.target.commandId : command.commandId) ||
        guest.phase !== (stop ? "stopping" : "pending")
      )
        return "unknown";
      const disposition = stop ? "interrupt_requested" : "applied";
      this.db
        .prepare(
          "UPDATE effect SET disposition=? WHERE id=? AND disposition='unknown'",
        )
        .run(disposition, command.commandId);
      this.db
        .prepare("UPDATE guest SET phase=? WHERE id=1")
        .run(stop ? "stopping" : "resident");
      return disposition;
    });
  }
  createdSession(commandId: string): string | null {
    const row = this.db
      .prepare("SELECT provider_thread FROM created_session WHERE command_id=?")
      .get(commandId);
    return typeof row?.provider_thread === "string"
      ? row.provider_thread
      : null;
  }
  private createFirst(
    command: Extract<ManagedGuestCommand, { type: "managed.thread.start" }>,
    digest: string,
    slot: SyntheticColdSlot,
  ): Disposition {
    const decision = this.transaction(() => {
      const current = this.check();
      const old = this.receipt(command.commandId);
      if (old) return this.replay(old, digest);
      if (
        current.phase !== "empty" ||
        current.revision !== 0 ||
        current.current_command !== null ||
        command.epoch.transferRevision !== 1 ||
        slot.inspectEmpty()?.physicalFence !== command.epoch.fence
      )
        return "stale";
      if (
        this.db
          .prepare(
            "SELECT id FROM effect WHERE claimed=1 AND (request=? OR fence >= ?) LIMIT 1",
          )
          .get(command.requestId, command.epoch.fence)
      )
        return "conflict";
      this.db
        .prepare(
          "INSERT INTO effect(id,digest,session,request,owner,fence,revision,thread,kind,disposition,claimed) VALUES(?,?,?,?,?,?,1,?,?,'unknown',1)",
        )
        .run(
          command.commandId,
          digest,
          this.ingress.sessionId,
          command.requestId,
          command.epoch.executionOwnerOperationId,
          command.epoch.fence,
          command.threadId,
          command.type,
        );
      this.db
        .prepare(
          "UPDATE guest SET current_command=?,revision=1,phase='creating' WHERE id=1",
        )
        .run(command.commandId);
      return "won";
    });
    if (decision !== "won") return decision;
    // The durable creating phase holds custody across either crash window.
    const created = slot.createSyntheticSession();
    if (
      !created.providerThreadId ||
      !created.bootId ||
      !created.processStart ||
      !Number.isSafeInteger(created.pid) ||
      created.pid < 1 ||
      created.physicalFence !== command.epoch.fence
    )
      return "unknown";
    return this.transaction(() => {
      const current = this.check();
      if (
        current.current_command !== command.commandId ||
        current.phase !== "creating"
      )
        return "unknown";
      this.db
        .prepare("INSERT INTO created_session VALUES(?,?)")
        .run(command.commandId, created.providerThreadId);
      const holder = canonicalJsonBytes({
        bootId: created.bootId,
        pid: created.pid,
        processStart: created.processStart,
      });
      this.db
        .prepare(
          "UPDATE guest SET phase='resident',provider_thread=?,holder=? WHERE id=1",
        )
        .run(created.providerThreadId, holder);
      this.db
        .prepare("UPDATE effect SET disposition='applied' WHERE id=?")
        .run(command.commandId);
      return "applied";
    });
  }
  private claim(
    command: ManagedGuestCommand,
    session: string,
    digest: string,
    local: SyntheticResidentObservation | null,
  ): Disposition | "won" {
    const guest = this.check();
    const previous = this.receipt(command.commandId);
    if (previous) return this.replay(previous, digest);
    const stop = command.type === "managed.thread.stop";
    const source = stop ? command.target : command;
    const epoch = source.epoch;
    this.db
      .prepare(
        "INSERT INTO effect(id,digest,session,request,owner,fence,revision,thread,kind,disposition,claimed) VALUES(?,?,?,?,?,?,?,?,?,'unavailable',0)",
      )
      .run(
        command.commandId,
        digest,
        session,
        source.requestId,
        epoch.executionOwnerOperationId,
        epoch.fence,
        epoch.transferRevision,
        command.threadId,
        command.type,
      );
    const refuse = (disposition: Disposition): Disposition => {
      this.db
        .prepare("UPDATE effect SET disposition=? WHERE id=?")
        .run(disposition, command.commandId);
      return disposition;
    };
    if (
      !local ||
      local.physicalFence !== epoch.fence ||
      !local.bootId ||
      !local.processStart ||
      !Number.isSafeInteger(local.pid) ||
      local.pid <= 0 ||
      !local.providerThreadId
    )
      return refuse("unavailable");
    const holder = canonicalJsonBytes({
      bootId: local.bootId,
      pid: local.pid,
      processStart: local.processStart,
    });
    if (command.type === "managed.thread.start") {
      if (
        guest.phase !== "empty" ||
        guest.revision !== 0 ||
        epoch.transferRevision !== 1 ||
        !local.idle
      )
        return refuse("stale");
    } else {
      const targetId = stop
        ? command.target.commandId
        : command.previousCommandId;
      const target = this.receipt(targetId);
      if (
        !target ||
        target.session !== session ||
        guest.current_command !== targetId ||
        target.thread !== command.threadId ||
        target.fence !== epoch.fence ||
        guest.holder !== holder ||
        guest.provider_thread !== local.providerThreadId
      )
        return refuse("stale");
      if (guest.phase !== "resident") return refuse("unknown");
      if (stop) {
        if (
          target.owner !== epoch.executionOwnerOperationId ||
          target.request !== source.requestId ||
          guest.revision !== epoch.transferRevision
        )
          return refuse("stale");
      } else if (
        !local.idle ||
        command.providerThreadId !== local.providerThreadId ||
        target.owner === epoch.executionOwnerOperationId ||
        epoch.transferRevision !== guest.revision + 1
      )
        return refuse("stale");
    }
    if (
      !stop &&
      this.db
        .prepare(
          "SELECT id FROM effect WHERE request=? AND claimed=1 AND kind!='managed.thread.stop'",
        )
        .get(source.requestId)
    )
      return refuse("conflict");
    this.db
      .prepare("UPDATE effect SET disposition='unknown',claimed=1 WHERE id=?")
      .run(command.commandId);
    if (stop)
      this.db.prepare("UPDATE guest SET phase='stopping' WHERE id=1").run();
    else
      this.db
        .prepare(
          "UPDATE guest SET phase='pending',revision=?,current_command=?,holder=?,provider_thread=? WHERE id=1",
        )
        .run(
          epoch.transferRevision,
          command.commandId,
          holder,
          local.providerThreadId,
        );
    return "won";
  }
  private replay(prior: EffectReceipt, digest: string): Disposition {
    if (prior.digest !== digest) return "conflict";
    const value = prior.disposition;
    return value === "applied" ||
      value === "interrupt_requested" ||
      value === "stale" ||
      value === "unavailable" ||
      value === "conflict"
      ? value
      : "unknown";
  }
}
