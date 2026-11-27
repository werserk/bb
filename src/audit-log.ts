import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";

// Append-only audit of routing and access decisions (block P2). It holds ids,
// reasons and a fixed-vocabulary detail only: never prompt content, model
// names, headers, tokens or passes.
export const AUDIT_REASONS = [
  "select",
  "failover",
  "limit",
  "pass-issued",
  "pass-revoked",
  "role-change",
] as const;
export const auditReasonSchema = z.enum(AUDIT_REASONS);
export type AuditReason = z.infer<typeof auditReasonSchema>;

// Every detail value the code writes. Role changes write "<from>-><to>".
const ROLE_NAME = "(server|worker|trusted|none)";
export const auditDetailSchema = z
  .string()
  .regex(
    new RegExp(
      `^(archived|deleted|restored|manual|role|host-removed|reconcile|quota|rate-limit|auth|upstream|${ROLE_NAME}->${ROLE_NAME})$`,
      "u",
    ),
  );

const idSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u);

// What this build writes: only its own reasons and detail vocabulary.
const auditRecordSchema = z
  .object({
    reason: auditReasonSchema,
    provider: z.enum(["claude", "codex"]).nullable(),
    threadId: idSchema.nullable(),
    hostId: idSchema.nullable(),
    accountId: z.string().min(1).nullable(),
    detail: auditDetailSchema.nullable(),
  })
  .strict();
export type AuditInput = Partial<
  Omit<z.infer<typeof auditRecordSchema>, "reason">
> & { reason: AuditReason };

// What it reads back: any row, so that rows written by a later build (new
// reasons and details) are shown as they are after a rollback.
const REASON_NAME = /^[a-z][a-z-]{0,63}$/u;
export const auditEntrySchema = z
  .object({
    id: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
    reason: z.string().min(1),
    provider: z.string().nullable(),
    threadId: z.string().nullable(),
    hostId: z.string().nullable(),
    accountId: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditQuerySchema = z
  .object({
    threadId: idSchema.optional(),
    hostId: idSchema.optional(),
    accountId: z.string().min(1).optional(),
    reason: z.string().regex(REASON_NAME).optional(),
    since: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const AUDIT_MAX_ROWS = 200_000;

const rowSchema = z.object({
  id: z.number(),
  ts: z.number(),
  reason: z.string(),
  provider: z.string().nullable(),
  thread_id: z.string().nullable(),
  host_id: z.string().nullable(),
  account_id: z.string().nullable(),
  detail: z.string().nullable(),
});

export class AuditLog {
  private readonly insert: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
    private readonly retentionMs = AUDIT_RETENTION_MS,
    private readonly maxRows = AUDIT_MAX_ROWS,
  ) {
    this.insert = db.prepare(
      "INSERT INTO pool_audit(ts, reason, provider, thread_id, host_id, account_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  append(input: AuditInput): void {
    const entry = auditRecordSchema.parse({
        reason: input.reason,
        provider: input.provider ?? null,
        threadId: input.threadId ?? null,
        hostId: input.hostId ?? null,
        accountId: input.accountId ?? null,
        detail: input.detail ?? null,
      });
    this.insert.run(
      this.now(),
      entry.reason,
      entry.provider,
      entry.threadId,
      entry.hostId,
      entry.accountId,
      entry.detail,
    );
  }

  prune(): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM pool_audit WHERE ts < ?")
        .run(this.now() - this.retentionMs);
      this.db
        .prepare(
          "DELETE FROM pool_audit WHERE id <= (SELECT id FROM pool_audit ORDER BY id DESC LIMIT 1 OFFSET ?)",
        )
        .run(this.maxRows);
    })();
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const filter = auditQuerySchema.parse(query);
    const where: string[] = [];
    const values: Array<string | number> = [];
    const add = (sql: string, value: string | number | undefined) => {
      if (value === undefined) return;
      where.push(sql);
      values.push(value);
    };
    add("thread_id = ?", filter.threadId);
    add("host_id = ?", filter.hostId);
    add("account_id = ?", filter.accountId);
    add("reason = ?", filter.reason);
    add("ts >= ?", filter.since);
    const rows = z
      .array(rowSchema)
      .parse(
        this.db
          .prepare(
            `SELECT id, ts, reason, provider, thread_id, host_id, account_id, detail FROM pool_audit${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY id DESC LIMIT ?`,
          )
          .all(...values, filter.limit ?? 100),
      );
    return rows.map((row) =>
      auditEntrySchema.parse({
        id: row.id,
        ts: row.ts,
        reason: row.reason,
        provider: row.provider,
        threadId: row.thread_id,
        hostId: row.host_id,
        accountId: row.account_id,
        detail: row.detail,
      }),
    );
  }
}

export const auditRpcContract = defineRpcContract({
  "audit.list": {
    input: auditQuerySchema,
    output: z.array(auditEntrySchema),
  },
});

export function createAuditHandlers(
  log: AuditLog,
): PluginRpcHandlers<typeof auditRpcContract> {
  return { "audit.list": (input) => log.list(input) };
}

const DURATION_UNITS: Record<string, number> = {
  m: 60 * 1_000,
  h: 60 * 60 * 1_000,
  d: 24 * 60 * 60 * 1_000,
};

export function parseSince(value: string, now: number): number {
  const relative = /^(\d+)([mhd])$/u.exec(value);
  if (relative !== null)
    return now - Number(relative[1]) * (DURATION_UNITS[relative[2] ?? "d"] ?? 0);
  const absolute = Date.parse(value);
  if (Number.isNaN(absolute))
    throw new Error("--since takes an ISO time or a duration such as 24h or 7d.");
  return absolute;
}

export function createAuditCommands(log: AuditLog, now: () => number) {
  return {
    audit: cliCommand({
      summary:
        "Show the Account Pooler audit log (account selection, failover, limits, passes, roles), newest first",
      options: {
        thread: { type: "string", description: "Only this thread ID" },
        host: { type: "string", description: "Only this machine ID" },
        account: { type: "string", description: "Only this account ID" },
        reason: {
          type: "string",
          description: `One of ${AUDIT_REASONS.join(", ")}`,
        },
        since: {
          type: "string",
          description: "ISO time, or a duration such as 30m, 24h, 7d",
        },
        limit: { type: "string", description: "At most this many rows (1-1000, default 100)" },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run: async (input) => {
        try {
          const options = input.options;
          const entries = log.list({
            ...(options.thread === undefined ? {} : { threadId: options.thread }),
            ...(options.host === undefined ? {} : { hostId: options.host }),
            ...(options.account === undefined
              ? {}
              : { accountId: options.account }),
            ...(options.reason === undefined
              ? {}
              : { reason: options.reason }),
            ...(options.since === undefined
              ? {}
              : { since: parseSince(options.since, now()) }),
            ...(options.limit === undefined
              ? {}
              : { limit: Number(options.limit) }),
          });
          return {
            exitCode: 0,
            stdout: options.json
              ? `${JSON.stringify({ entries })}\n`
              : entries.length === 0
                ? "No audit entries.\n"
                : `${entries
                    .map((entry) =>
                      [
                        new Date(entry.ts).toISOString(),
                        entry.reason,
                        entry.provider ?? "-",
                        entry.threadId ?? "-",
                        entry.hostId ?? "-",
                        entry.accountId ?? "-",
                        entry.detail ?? "-",
                      ].join("\t"),
                    )
                    .join("\n")}\n`,
          };
        } catch (error) {
          throw new PluginCliError(
            error instanceof z.ZodError
              ? "Invalid audit filter."
              : error instanceof Error
                ? error.message
                : String(error),
            { code: "pool_command_failed" },
          );
        }
      },
    }),
  };
}
