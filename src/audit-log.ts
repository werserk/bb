import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";

// Append-only audit of routing and access decisions (blocks P2, P3). It holds
// ids, reasons and a fixed-vocabulary detail only: never prompt content, model
// names, headers, tokens or passes.
export const AUDIT_REASONS = [
  "select",
  "failover",
  "limit",
  "pass-issued",
  "pass-revoked",
  "role-change",
  // Thread account policy (block P3, thread-policy.ts).
  "switch",
  "policy",
  "named-limit",
] as const;
export const auditReasonSchema = z.enum(AUDIT_REASONS);
export type AuditReason = z.infer<typeof auditReasonSchema>;

// Every detail value the code writes. Role changes write "<from>-><to>".
// Policy changes write "<policy>@<caller>[+new-session]" and named-account
// events "<cause>-<rule>" (block P3).
const ROLE_NAME = "(server|worker|trusted|none)";
const POLICY_DETAIL =
  "(auto|named-fallback-auto|named-stop)@(client|cli|limit|revert|plugin-[a-z0-9-]{1,48})(\\+new-session)?";
const NAMED_LIMIT_DETAIL = "(limit|deleted|unavailable)-(fallback-auto|stop)";
export const auditDetailSchema = z
  .string()
  .regex(
    new RegExp(
      `^(archived|deleted|restored|manual|role|host-removed|reconcile|quota|rate-limit|auth|upstream|${ROLE_NAME}->${ROLE_NAME}|${POLICY_DETAIL}|${NAMED_LIMIT_DETAIL})$`,
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

// Rows that say an account served a thread. A `failover` row is written
// before its attempt, so it is not proof; a served failover also writes
// `select`.
const SERVING_REASONS = "('select', 'switch')";

// What it reads back: any well-formed row, so that rows written by a later
// build (new reasons and details) are shown as they are after a rollback. A
// row that breaks the id and time invariants, or holds an overlong or control
// character value, is skipped and counted instead of failing the whole list.
const REASON_NAME = /^[a-z][a-z-]{0,63}$/u;
// eslint-disable-next-line no-control-regex
const readText = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const auditEntrySchema = z
  .object({
    id: z.number().int().positive(),
    ts: z.number().int().nonnegative(),
    reason: readText,
    provider: readText.nullable(),
    threadId: readText.nullable(),
    hostId: readText.nullable(),
    accountId: readText.nullable(),
    detail: readText.nullable(),
  })
  .strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditListSchema = z
  .object({
    entries: z.array(auditEntrySchema),
    skipped: z.number().int().nonnegative(),
  })
  .strict();
export type AuditList = z.infer<typeof auditListSchema>;

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

const rowSchema = z
  .object({
    id: z.unknown(),
    ts: z.unknown(),
    reason: z.unknown(),
    provider: z.unknown(),
    thread_id: z.unknown(),
    host_id: z.unknown(),
    account_id: z.unknown(),
    detail: z.unknown(),
  })
  .transform((row) => ({
    id: row.id,
    ts: row.ts,
    reason: row.reason,
    provider: row.provider,
    threadId: row.thread_id,
    hostId: row.host_id,
    accountId: row.account_id,
    detail: row.detail,
  }))
  .pipe(auditEntrySchema);

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

  // The account that last served a thread: its latest select or switch row
  // (block P3). Rows past the retention are gone, so an old thread
  // reads as not routed until its next request.
  latestServing(threadId: string): { accountId: string; at: number } | null {
    const row = z
      .object({ account_id: z.string().min(1), ts: z.number().int() })
      .optional()
      .safeParse(
        this.db
          .prepare(
            `SELECT account_id, ts FROM pool_audit WHERE thread_id = ? AND reason IN ${SERVING_REASONS} AND account_id IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1`,
          )
          .get(threadId),
      );
    return row.success && row.data !== undefined
      ? { accountId: row.data.account_id, at: row.data.ts }
      : null;
  }

  // The latest serving row of every thread routed since `since` (block P3).
  recentServing(
    since: number,
  ): Array<{ threadId: string; accountId: string; at: number }> {
    return z
      .array(
        z.object({
          thread_id: z.string().min(1),
          account_id: z.string().min(1),
          ts: z.number().int(),
        }),
      )
      .catch([])
      .parse(
        this.db
          .prepare(
            `SELECT thread_id, account_id, MAX(ts) AS ts FROM pool_audit WHERE ts >= ? AND thread_id IS NOT NULL AND account_id IS NOT NULL AND reason IN ${SERVING_REASONS} GROUP BY thread_id ORDER BY ts DESC`,
          )
          .all(since),
      )
      .map((row) => ({
        threadId: row.thread_id,
        accountId: row.account_id,
        at: row.ts,
      }));
  }

  // Model sessions selected on a machine token, not a thread pass, since
  // `since`: one `select` row per session account change (block P3).
  machineTokenSelections(since: number): number {
    return z
      .object({ count: z.number().int() })
      .parse(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM pool_audit WHERE ts >= ? AND reason = 'select' AND thread_id IS NULL",
          )
          .get(since),
      ).count;
  }

  // A thread's latest row of one reason: one indexed lookup (block P3). null
  // when there is none or it does not parse.
  latestEvent(threadId: string, reason: string): AuditEntry | null {
    const parsed = rowSchema.safeParse(
      this.db
        .prepare(
          "SELECT id, ts, reason, provider, thread_id, host_id, account_id, detail FROM pool_audit WHERE thread_id = ? AND reason = ? ORDER BY ts DESC, id DESC LIMIT 1",
        )
        .get(threadId, reason),
    );
    return parsed.success ? parsed.data : null;
  }

  // A thread's account events, oldest first after `afterId` (block P3).
  threadEvents(
    threadId: string,
    reasons: readonly string[],
    afterId: number,
    limit: number,
  ): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, reason, provider, thread_id, host_id, account_id, detail FROM pool_audit WHERE thread_id = ? AND id > ? AND reason IN (${reasons.map(() => "?").join(", ")}) ORDER BY id ASC LIMIT ?`,
      )
      .all(threadId, afterId, ...reasons, limit);
    const entries: AuditEntry[] = [];
    for (const row of rows) {
      const parsed = rowSchema.safeParse(row);
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  }

  list(query: AuditQuery = {}): AuditList {
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
    const rows = this.db
      .prepare(
        `SELECT id, ts, reason, provider, thread_id, host_id, account_id, detail FROM pool_audit${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY id DESC LIMIT ?`,
      )
      .all(...values, filter.limit ?? 100);
    const entries: AuditEntry[] = [];
    for (const row of rows) {
      const parsed = rowSchema.safeParse(row);
      if (parsed.success) entries.push(parsed.data);
    }
    return { entries, skipped: rows.length - entries.length };
  }
}

export const auditRpcContract = defineRpcContract({
  "audit.list": {
    input: auditQuerySchema,
    output: auditListSchema,
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
          const { entries, skipped } = log.list({
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
            ...(skipped === 0 || options.json
              ? {}
              : {
                  stderr: `${skipped} audit row(s) could not be read and were skipped.\n`,
                }),
            stdout: options.json
              ? `${JSON.stringify({ entries, skipped })}\n`
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
