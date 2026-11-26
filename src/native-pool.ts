import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
const id = z.string().min(1);
export const nativeCellSchema = z
  .object({
    id,
    hostId: id,
    generation: id,
    label: id,
    workspace: z.string().startsWith("/"),
    sshTarget: id,
  })
  .strict();
export const nativeSubmitSchema = z
  .object({
    submissionKey: id,
    projectId: id,
    input: z.string().min(1),
    cellId: id.optional(),
  })
  .strict();
export type NativeCell = z.infer<typeof nativeCellSchema> & {
  enabled: boolean;
  qualified: boolean;
};
export type IntentPhase =
  | "waiting"
  | "reserved"
  | "creating"
  | "bound"
  | "transferring"
  | "queued"
  | "unknown"
  | "released"
  | "cancelling"
  | "cancelled";
export type SlotPhase =
  "free" | "reserved" | "resident" | "draining" | "unknown";
export type NativeIntent = {
  id: string;
  submissionKey: string;
  projectId: string;
  input: string | null;
  digest: string;
  requestedCell: string | null;
  cellId: string | null;
  threadId: string | null;
  queueId: string | null;
  phase: IntentPhase;
  detail: string | null;
};
export type NativeSlot = {
  cellId: string;
  intentId: string | null;
  threadId: string | null;
  phase: SlotPhase;
  epoch: string | null;
  observedAt: number | null;
};
export type NativeBinding = {
  threadId: string;
  cellId: string;
  generation: string;
  intentId: string;
};
export interface NativeClients {
  enrolledHost?(hostId: string): Promise<boolean>;
  observe(cell: NativeCell): Promise<{
    generation: string;
    epoch: string;
    lock: "held" | "free" | "unknown";
    threadId: string | null;
  }>;
  spawn(input: {
    projectId: string;
    hostId: string;
    workspace: string;
    input: [];
    originKind: null;
    pluginMetadata: {
      nativePool: {
        operationId: string;
        cellId: string;
        accountGeneration: string;
      };
    };
  }): Promise<{
    threadId: string;
  }>;
  send(
    threadId: string,
    input: string,
  ): Promise<
    | {
        kind: "queued";
        queueId: string;
      }
    | {
        kind: "sent";
      }
  >;
  recheck(threadId: string): Promise<void>;
  findCreated(intent: NativeIntent): Promise<
    Array<{
      threadId: string;
      cellId: string;
      generation: string;
    }>
  >;
  releaseIdle(threadId: string): Promise<"released" | "busy" | "unknown">;
  stop(threadId: string): Promise<void>;
  cancelQueue(threadId: string, queueId: string): Promise<void>;
}
export const NATIVE_POOL_MIGRATION = `
CREATE TABLE native_policy (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, qualified INTEGER NOT NULL DEFAULT 0, qualification TEXT);
INSERT INTO native_policy(id) VALUES(1);
CREATE TABLE native_cell (id TEXT PRIMARY KEY, hostId TEXT NOT NULL UNIQUE, generation TEXT NOT NULL, label TEXT NOT NULL, workspace TEXT NOT NULL, sshTarget TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, qualified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE native_intent (id TEXT PRIMARY KEY, submissionKey TEXT NOT NULL UNIQUE, projectId TEXT NOT NULL, input TEXT, digest TEXT NOT NULL, requestedCell TEXT, cellId TEXT, threadId TEXT, queueId TEXT, phase TEXT NOT NULL, detail TEXT);
CREATE TABLE native_binding (threadId TEXT PRIMARY KEY, cellId TEXT NOT NULL REFERENCES native_cell(id), generation TEXT NOT NULL, intentId TEXT NOT NULL UNIQUE REFERENCES native_intent(id));
CREATE TABLE native_slot (cellId TEXT PRIMARY KEY REFERENCES native_cell(id), intentId TEXT, threadId TEXT, phase TEXT NOT NULL DEFAULT 'free', epoch TEXT, observedAt INTEGER);
CREATE TRIGGER native_binding_immutable_update BEFORE UPDATE ON native_binding BEGIN SELECT RAISE(ABORT,'Native binding is immutable'); END;
CREATE TRIGGER native_binding_immutable_delete BEFORE DELETE ON native_binding BEGIN SELECT RAISE(ABORT,'Native binding is immutable'); END;
CREATE TRIGGER native_cell_identity_immutable BEFORE UPDATE OF id,hostId,generation,workspace ON native_cell BEGIN SELECT RAISE(ABORT,'Native cell identity is immutable'); END;
`;
export class NativePoolStore {
  constructor(readonly db: Database.Database) {}
  enroll(input: z.infer<typeof nativeCellSchema>) {
    const c = nativeCellSchema.parse(input);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO native_cell(id,hostId,generation,label,workspace,sshTarget) VALUES (@id,@hostId,@generation,@label,@workspace,@sshTarget)",
        )
        .run(c);
      this.db.prepare("INSERT INTO native_slot(cellId) VALUES (?)").run(c.id);
    })();
  }
  configure(cellId: string, enabled: boolean, qualified: boolean) {
    this.db
      .prepare("UPDATE native_cell SET enabled=?,qualified=? WHERE id=?")
      .run(+enabled, +qualified, cellId);
  }
  isExcluded(hostId: string) {
    return !!this.db
      .prepare("SELECT host_id FROM pool_host_exclusion WHERE host_id=?")
      .get(hostId);
  }
  policy() {
    const p = this.db
      .prepare("SELECT enabled,qualified FROM native_policy WHERE id=1")
      .get() as { enabled: number; qualified: number };
    return { enabled: !!p.enabled, qualified: !!p.qualified };
  }
  setPolicy(
    enabled: boolean,
    qualified: boolean,
    qualification: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE native_policy SET enabled=?,qualified=?,qualification=? WHERE id=1",
      )
      .run(+enabled, +qualified, qualification);
  }
  status() {
    return {
      cells: (
        this.db.prepare("SELECT * FROM native_cell").all() as Array<
          Omit<NativeCell, "enabled" | "qualified"> & {
            enabled: number;
            qualified: number;
          }
        >
      ).map((c) => ({ ...c, enabled: !!c.enabled, qualified: !!c.qualified })),
      intents: this.db
        .prepare("SELECT * FROM native_intent ORDER BY rowid")
        .all() as NativeIntent[],
      slots: this.db.prepare("SELECT * FROM native_slot").all() as NativeSlot[],
      bindings: this.db
        .prepare("SELECT * FROM native_binding")
        .all() as NativeBinding[],
    };
  }
  intent(id: string) {
    const result = this.db
      .prepare("SELECT * FROM native_intent WHERE id=?")
      .get(id) as NativeIntent | undefined;
    if (!result) throw new Error("Unknown intent");
    return result;
  }
  create(input: z.infer<typeof nativeSubmitSchema>) {
    const p = nativeSubmitSchema.parse(input);
    const digest = createHash("sha256")
      .update(JSON.stringify([p.projectId, p.input, p.cellId ?? null]))
      .digest("hex");
    return this.db.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM native_intent WHERE submissionKey=?")
        .get(p.submissionKey) as NativeIntent | undefined;
      if (old) {
        if (old.digest !== digest)
          throw new Error("Submission key already belongs to different input");
        return old;
      }
      const operationId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO native_intent(id,submissionKey,projectId,input,digest,requestedCell,phase) VALUES (?,?,?,?,?,?,'waiting')",
        )
        .run(
          operationId,
          p.submissionKey,
          p.projectId,
          p.input,
          digest,
          p.cellId ?? null,
        );
      return this.intent(operationId);
    })();
  }
  eligibleCells(requestedCell: string | null = null): NativeCell[] {
    return this.status().cells.filter(
      (c) =>
        c.enabled &&
        c.qualified &&
        this.isExcluded(c.hostId) &&
        (!requestedCell || c.id === requestedCell),
    );
  }
  reserve(intentId: string): NativeCell | null {
    return this.db
      .transaction(() => {
        const intent = this.intent(intentId);
        if (intent.phase !== "waiting") return null;
        const slots = this.status().slots;
        const c = this.eligibleCells(intent.requestedCell).find((c) =>
          slots.some((s) => s.cellId === c.id && s.phase === "free"),
        );
        if (!c) return null;
        const changed = this.db
          .prepare(
            "UPDATE native_slot SET phase='reserved',intentId=?,threadId=NULL WHERE cellId=? AND phase='free'",
          )
          .run(intentId, c.id);
        if (changed.changes !== 1) return null;
        this.db
          .prepare(
            "UPDATE native_intent SET phase='reserved',cellId=? WHERE id=? AND phase='waiting'",
          )
          .run(c.id, intentId);
        return c;
      })
      .immediate();
  }
  phase(id: string, phase: IntentPhase, detail: string | null = null) {
    this.db
      .prepare("UPDATE native_intent SET phase=?,detail=? WHERE id=?")
      .run(phase, detail, id);
  }
  unknown(id: string, detail: string) {
    this.db.transaction(() => {
      if (this.intent(id).phase !== "cancelling")
        this.phase(id, "unknown", detail);
      this.db
        .prepare("UPDATE native_slot SET phase='unknown' WHERE intentId=?")
        .run(id);
    })();
  }
  bind(id: string, threadId: string) {
    this.db.transaction(() => {
      const i = this.intent(id);
      const c = this.status().cells.find((c) => c.id === i.cellId);
      if (!c) throw new Error("Missing cell");
      this.db
        .prepare(
          "INSERT INTO native_binding(threadId,cellId,generation,intentId) VALUES (?,?,?,?)",
        )
        .run(threadId, c.id, c.generation, id);
      this.db
        .prepare(
          "UPDATE native_intent SET threadId=?,phase=CASE WHEN phase='cancelling' THEN phase ELSE 'bound' END WHERE id=?",
        )
        .run(threadId, id);
      this.db
        .prepare("UPDATE native_slot SET threadId=? WHERE intentId=?")
        .run(threadId, id);
    })();
  }
  custody(id: string, queueId: string) {
    if (!queueId) throw new Error("Missing queue ID");
    this.db
      .prepare(
        "UPDATE native_intent SET queueId=?, input=NULL, phase=CASE WHEN phase='cancelling' THEN phase ELSE 'queued' END WHERE id=? AND phase IN ('transferring','cancelling')",
      )
      .run(queueId, id);
  }
}
export class NativePool {
  private reconciling = false;
  private startupHeld: boolean;
  private pumping = false;
  private active = new Set<string>();
  constructor(
    readonly store: NativePoolStore,
    private clients: NativeClients,
    private policy = store.policy(),
  ) {
    this.startupHeld = store.status().slots.some((s) => s.phase !== "free");
  }
  status() {
    return {
      ...this.store.status(),
      enabled: this.policy.enabled,
      qualified: this.policy.qualified,
      reconciling: this.reconciling || this.startupHeld,
    };
  }
  async submit(input: z.infer<typeof nativeSubmitSchema>) {
    const intent = this.store.create(input);
    if (
      this.policy.enabled &&
      this.policy.qualified &&
      !this.reconciling &&
      !this.startupHeld &&
      intent.phase === "waiting"
    )
      await this.advance(intent.id);
    if (this.store.intent(intent.id).phase === "waiting") await this.pump();
    return this.store.intent(intent.id);
  }
  private async advance(id: string) {
    const cell = this.store.reserve(id);
    if (!cell) return;
    this.active.add(id);
    try {
      const observation = await this.clients.observe(cell);
      if (
        observation.lock !== "free" ||
        observation.generation !== cell.generation
      )
        throw new Error("Worker lock or generation is unresolved");
      if (this.store.intent(id).phase !== "reserved") return;
      if (!this.store.isExcluded(cell.hostId))
        throw new Error("Central exclusion removed");
      this.store.phase(id, "creating");
      const i = this.store.intent(id);
      const result = await this.clients.spawn({
        projectId: i.projectId,
        hostId: cell.hostId,
        workspace: cell.workspace,
        input: [],
        originKind: null,
        pluginMetadata: {
          nativePool: {
            operationId: id,
            cellId: cell.id,
            accountGeneration: cell.generation,
          },
        },
      });
      const beforeBind = this.store.intent(id).phase;
      this.store.bind(id, result.threadId);
      if (beforeBind !== "creating" && beforeBind !== "cancelling") {
        this.store.unknown(id, "Worker state changed during create");
        return;
      }
      if (this.store.intent(id).phase === "cancelling") await this.stop(id);
      else await this.transfer(id);
    } catch {
      this.store.unknown(
        id,
        "Creation or transfer outcome requires reconciliation",
      );
    } finally {
      this.active.delete(id);
    }
  }
  private async transfer(id: string) {
    const i = this.store.intent(id);
    if (i.phase !== "bound" || !i.threadId || i.input === null) return;
    const cell = this.store.status().cells.find((c) => c.id === i.cellId);
    if (
      !this.policy.enabled ||
      !this.policy.qualified ||
      !cell?.enabled ||
      !cell.qualified ||
      !this.store.isExcluded(cell.hostId)
    ) {
      this.store.unknown(id, "Configuration changed before transfer");
      return;
    }
    this.store.phase(id, "transferring");
    const result = await this.clients.send(i.threadId, i.input);
    if (result.kind !== "queued")
      throw new Error("Initial send did not enter held queue");
    this.store.custody(id, result.queueId);
    if (this.store.intent(id).phase === "cancelling") await this.stop(id);
    else await this.clients.recheck(i.threadId);
  }
  async enroll(input: z.infer<typeof nativeCellSchema>) {
    const c = nativeCellSchema.parse(input);
    if (!(await this.clients.enrolledHost?.(c.hostId)))
      throw new Error("Host must be enrolled in BB");
    if (
      !this.store.db
        .prepare("SELECT host_id FROM pool_host_exclusion WHERE host_id=?")
        .get(c.hostId)
    )
      throw new Error("Exclude host from central pooling before enrollment");
    this.store.enroll(c);
    return this.status();
  }
  configure(input: {
    cellId?: string;
    enabled: boolean;
    qualified: boolean;
    qualification?: string;
  }) {
    if (input.qualified && input.qualification !== "installed-worker-verified")
      throw new Error(
        "Qualification requires explicit installed-worker-verified operator assertion",
      );
    if (input.enabled && !input.qualified)
      throw new Error("Cannot enable an unqualified controller or cell");
    if (input.cellId) {
      const c = this.store.status().cells.find((c) => c.id === input.cellId);
      if (!c) throw new Error("Unknown cell");
      if (
        input.enabled &&
        !this.store.db
          .prepare("SELECT host_id FROM pool_host_exclusion WHERE host_id=?")
          .get(c.hostId)
      )
        throw new Error("Host must remain excluded from central pooling");
      this.store.configure(input.cellId, input.enabled, input.qualified);
    } else {
      this.store.setPolicy(
        input.enabled,
        input.qualified,
        input.qualification ?? null,
      );
      this.policy = { enabled: input.enabled, qualified: input.qualified };
    }
    return this.status();
  }
  workerLost(hostId: string) {
    const state = this.store.status();
    const c = state.cells.find((c) => c.hostId === hostId);
    const slot = state.slots.find((s) => s.cellId === c?.id);
    if (slot?.intentId)
      this.store.unknown(
        slot.intentId,
        "Worker disconnected; capacity retained",
      );
  }
  async capacityChanged() {
    if (
      this.reconciling ||
      this.startupHeld ||
      !this.policy.enabled ||
      !this.policy.qualified
    )
      return;
    // BB owns continuation messages. Recheck its plugin-held rows before
    // admitting new intents so a released binding can reserve its own cell.
    const eligible = new Set(this.store.eligibleCells().map((c) => c.id));
    const resumes = this.store
      .status()
      .intents.filter(
        (i) =>
          i.phase === "released" &&
          i.threadId &&
          i.cellId &&
          eligible.has(i.cellId),
      );
    for (const intent of resumes) await this.clients.recheck(intent.threadId!);
    await this.pump();
  }
  async pump() {
    if (
      this.pumping ||
      this.active.size ||
      this.reconciling ||
      this.startupHeld ||
      !this.policy.enabled ||
      !this.policy.qualified
    )
      return;
    this.pumping = true;
    try {
      for (const intent of this.store
        .status()
        .intents.filter((i) => i.phase === "waiting")) {
        const eligible = new Set(
          this.store.eligibleCells(intent.requestedCell).map((c) => c.id),
        );
        const candidates = this.store
          .status()
          .slots.filter((s) => eligible.has(s.cellId));
        let free = candidates.some((s) => s.phase === "free");
        if (!free) {
          for (const slot of candidates) {
            if ((await this.release(slot.cellId)) === "released") {
              free = true;
              break;
            }
          }
        }
        if (free) await this.advance(intent.id);
      }
    } finally {
      this.pumping = false;
    }
  }
  async resume(threadId: string, hostId: string) {
    if (
      this.reconciling ||
      this.startupHeld ||
      !this.policy.enabled ||
      !this.policy.qualified
    )
      return false;
    const state = this.store.status();
    const b = state.bindings.find((b) => b.threadId === threadId);
    const c = state.cells.find((c) => c.hostId === hostId);
    if (
      !b ||
      !c ||
      b.cellId !== c.id ||
      b.generation !== c.generation ||
      !c.enabled ||
      !c.qualified ||
      !this.store.isExcluded(c.hostId)
    )
      return false;
    if (this.dispatch(threadId, hostId).allow) return true;
    if (this.store.intent(b.intentId).phase !== "released") return false;
    const slot = state.slots.find((s) => s.cellId === c.id)!;
    if (slot.phase !== "free" && (await this.release(c.id)) !== "released")
      return false;
    const claimed = this.store.db
      .prepare(
        "UPDATE native_slot SET phase='reserved',intentId=?,threadId=? WHERE cellId=? AND phase='free'",
      )
      .run(b.intentId, threadId, c.id);
    if (claimed.changes !== 1) return false;
    this.active.add(b.intentId);
    try {
      const o = await this.clients.observe(c);
      if (o.lock !== "free" || o.generation !== b.generation)
        throw new Error("Resume lock unresolved");
      if (this.store.intent(b.intentId).phase === "cancelling") return false;
      this.store.phase(b.intentId, "queued");
      return true;
    } catch {
      this.store.unknown(b.intentId, "Resume worker unavailable");
      return false;
    } finally {
      this.active.delete(b.intentId);
    }
  }
  async release(cellId: string) {
    if (
      !this.policy.enabled ||
      !this.policy.qualified ||
      this.reconciling ||
      this.active.size
    )
      return "unknown" as const;
    const cell = this.store.status().cells.find((c) => c.id === cellId);
    const slot = this.store.status().slots.find((s) => s.cellId === cellId);
    if (
      !cell ||
      !cell.enabled ||
      !cell.qualified ||
      !slot?.threadId ||
      !slot.intentId ||
      this.store.intent(slot.intentId).phase !== "queued" ||
      !["reserved", "resident"].includes(slot.phase)
    )
      return "unknown" as const;
    this.store.db
      .prepare("UPDATE native_slot SET phase='draining' WHERE cellId=?")
      .run(cellId);
    this.active.add(slot.intentId);
    try {
      const result = await this.clients.releaseIdle(slot.threadId);
      if (this.store.intent(slot.intentId).phase === "cancelling")
        throw new Error("Stop raced idle release");
      if (result === "busy") {
        this.store.db
          .prepare("UPDATE native_slot SET phase=? WHERE cellId=?")
          .run(slot.phase, cellId);
        return result;
      }
      const observation = await this.clients.observe(cell);
      if (this.store.intent(slot.intentId).phase === "cancelling")
        throw new Error("Stop raced release");
      if (
        result !== "released" ||
        observation.lock !== "free" ||
        observation.generation !== cell.generation
      )
        throw new Error("Release not proven");
      this.store.db.transaction(() => {
        this.store.phase(slot.intentId!, "released");
        this.store.db
          .prepare(
            "UPDATE native_slot SET phase='free',intentId=NULL,threadId=NULL,epoch=?,observedAt=? WHERE cellId=? AND phase='draining'",
          )
          .run(observation.epoch, Date.now(), cellId);
      })();
      return "released" as const;
    } catch {
      this.store.unknown(
        slot.intentId,
        "Idle release or lock freedom unresolved",
      );
      return "unknown" as const;
    } finally {
      this.active.delete(slot.intentId);
    }
  }
  async stop(intentId: string) {
    const i = this.store.intent(intentId);
    this.store.phase(
      intentId,
      "cancelling",
      "Explicit Stop requested; retry resurrection is not qualified",
    );
    this.store.db
      .prepare("UPDATE native_slot SET phase='unknown' WHERE intentId=?")
      .run(intentId);
    if (i.threadId) {
      // A dispatched initial queue row is normally already gone. Cleanup and
      // explicit interruption are independent, including transport failures.
      const [cleanup, interruption] = await Promise.allSettled([
        (async () => {
          if (i.queueId) await this.clients.cancelQueue(i.threadId!, i.queueId);
        })(),
        (async () => {
          await this.clients.stop(i.threadId!);
        })(),
      ]);
      const detail = [
        cleanup.status === "rejected"
          ? "Queue cleanup unconfirmed for the exact owned row."
          : i.queueId
            ? "Owned queue cleanup acknowledged."
            : "No owned queue row to delete.",
        interruption.status === "rejected"
          ? "Thread Stop outcome unconfirmed."
          : "Thread Stop acknowledged.",
        "Capacity remains unknown; retry resurrection is not qualified.",
      ].join(" ");
      this.store.phase(intentId, "cancelling", detail);
    } else if (!i.cellId) this.store.phase(intentId, "cancelled");
    return this.store.intent(intentId);
  }
  async reconcile() {
    if (this.reconciling || this.active.size) return this.status();
    this.reconciling = true;
    try {
      for (const original of this.store.status().intents) {
        if (
          ["waiting", "cancelled", "cancelling", "released"].includes(
            original.phase,
          )
        )
          continue;
        const cell = this.store
          .status()
          .cells.find((c) => c.id === original.cellId);
        if (!cell) continue;
        try {
          if (
            !this.policy.enabled ||
            !this.policy.qualified ||
            !cell.enabled ||
            !cell.qualified ||
            !this.store.isExcluded(cell.hostId)
          )
            continue;
          const observation = await this.clients.observe(cell);
          this.store.db
            .prepare(
              "UPDATE native_slot SET epoch=?,observedAt=? WHERE cellId=?",
            )
            .run(observation.epoch, Date.now(), cell.id);
          if (
            observation.generation !== cell.generation ||
            observation.lock === "unknown" ||
            (observation.lock === "held" &&
              (!observation.threadId ||
                observation.threadId !== original.threadId))
          ) {
            this.store.unknown(
              original.id,
              "Worker identity or lock unresolved",
            );
            continue;
          }
          let i = this.store.intent(original.id);
          if (!i.threadId) {
            const matches = await this.clients.findCreated(i);
            if (
              matches.length !== 1 ||
              matches[0].cellId !== cell.id ||
              matches[0].generation !== cell.generation
            ) {
              this.store.unknown(
                i.id,
                "Create attribution is absent or ambiguous",
              );
              continue;
            }
            this.store.bind(i.id, matches[0].threadId);
            i = this.store.intent(i.id);
          }
          if (i.phase === "cancelling") {
            await this.stop(i.id);
            continue;
          }
          if (i.queueId) {
            this.store.phase(i.id, "queued");
            this.store.db
              .prepare("UPDATE native_slot SET phase=? WHERE intentId=?")
              .run(observation.lock === "held" ? "resident" : "reserved", i.id);
            await this.clients.recheck(i.threadId!);
          } else if (i.phase === "bound") {
            this.store.db
              .prepare(
                "UPDATE native_slot SET phase='reserved' WHERE intentId=?",
              )
              .run(i.id);
            await this.transfer(i.id);
          } else
            this.store.unknown(
              i.id,
              "Initial delivery has no exact durable queue ID; manual recovery required",
            );
        } catch {
          this.store.unknown(
            original.id,
            "Reconciliation unavailable; capacity retained",
          );
        }
      }
    } finally {
      this.reconciling = false;
      this.startupHeld = false;
    }
    // Recheck after leaving startup/reconciliation hold, only for known custody.
    for (const i of this.store
      .status()
      .intents.filter((i) => i.phase === "queued" && i.threadId)) {
      try {
        await this.clients.recheck(i.threadId!);
      } catch {
        /* A wake failure never re-sends input. */
      }
    }
    await this.pump();
    return this.status();
  }
  dispatch(
    threadId: string,
    hostId: string,
  ): {
    allow: boolean;
    reason: string;
  } {
    const state = this.store.status();
    const c = state.cells.find((c) => c.hostId === hostId);
    if (!c) return { allow: true, reason: "Unmanaged host" };
    if (
      this.reconciling ||
      this.startupHeld ||
      !this.policy.enabled ||
      !this.policy.qualified ||
      !c.enabled ||
      !c.qualified ||
      !this.store.isExcluded(c.hostId)
    )
      return {
        allow: false,
        reason: "Native worker disabled, unqualified or reconciling",
      };
    const b = state.bindings.find((b) => b.threadId === threadId);
    const s = state.slots.find((s) => s.cellId === c.id);
    const i = state.intents.find((i) => i.id === b?.intentId);
    return b?.cellId === c.id &&
      b.generation === c.generation &&
      s?.threadId === threadId &&
      ["reserved", "resident"].includes(s.phase) &&
      i?.phase === "queued" &&
      !!i.queueId
      ? { allow: true, reason: "Native resident owner" }
      : { allow: false, reason: "Native capacity or initial custody hold" };
  }
}
