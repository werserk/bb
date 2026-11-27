import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";

// Machine roles, default deny: a host is served by the pool only while it has a
// row in pool_host_role. No row means no env, no hub token, no authentication.
// `server` and `trusted` get the machine's hub token; `worker` gets per-thread
// passes and never a hub token (thread-pass.ts).
export const HOST_ROLES = ["server", "worker", "trusted"] as const;
export const hostIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const hostRoleSchema = z.enum(HOST_ROLES);
export type HostRole = z.infer<typeof hostRoleSchema>;
export const hostRoleInputSchema = z
  .object({ hostId: hostIdSchema, role: z.enum([...HOST_ROLES, "none"]) })
  .strict();
export const hostRoleSummarySchema = z
  .object({
    hostId: hostIdSchema,
    hostName: z.string().nullable(),
    enrolled: z.boolean(),
    role: hostRoleSchema.nullable(),
  })
  .strict();
export type HostRoleSummary = z.infer<typeof hostRoleSummarySchema>;

export class HostNotPermittedError extends Error {
  constructor(hostId: string) {
    super(`Machine ${hostId} has no Account Pooler role.`);
  }
}

const roleRowsSchema = z.array(
  z.object({ host_id: hostIdSchema, role: hostRoleSchema }),
);

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

// Rewrites pool_host_exclusion, the only input of the previous (opt-out) build,
// from roles: a row for every enrolled host without a role and for every
// `worker` (enrolled or not, since a removed machine keeps its role and may come
// back under the same id), none for `server` or `trusted`. A rollback then keeps
// every role-less host and every worker closed: the opt-out build excludes
// them, and the first roles build drops the worker's role at its start, so no
// older build ever mints a hub token for a worker. Synchronous on purpose.
export function projectExclusions(
  db: Database.Database,
  enrolledHostIds: readonly string[],
): void {
  db.transaction(() => {
    db.prepare(
      "DELETE FROM pool_host_exclusion WHERE host_id IN (SELECT host_id FROM pool_host_role WHERE role <> 'worker')",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO pool_host_exclusion(host_id) SELECT host_id FROM pool_host_role WHERE role = 'worker'",
    ).run();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO pool_host_exclusion(host_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM pool_host_role WHERE host_id = ?)",
    );
    for (const hostId of enrolledHostIds) insert.run(hostId, hostId);
  })();
}

// Start-time migration, one transaction with the SDK migrator:
// - upgrade from the opt-out build: every enrolled host without an exclusion row
//   gets "trusted", so today's routing is kept; excluded hosts get nothing;
// - a fresh store: no host gets a role;
// - every start: an exclusion row beats a role. Only the previous build writes
//   such a pair (an exclusion made during a rollback), so the exclusion wins.
//   Workers are skipped: their exclusion rows are this build's own projection;
// - then the rollback projection.
export function migrateHostRoles(
  db: Database.Database,
  migrate: () => void,
  enrolledHostIds: readonly string[],
): void {
  db.transaction(() => {
    const upgrading =
      tableExists(db, "pool_host_exclusion") &&
      !tableExists(db, "pool_host_role");
    migrate();
    if (upgrading) {
      // Excluded hosts are seeded too and lose the role in the reconcile below.
      const seed = db.prepare(
        "INSERT OR IGNORE INTO pool_host_role(host_id, role) VALUES (?, 'trusted')",
      );
      for (const hostId of enrolledHostIds) seed.run(hostId);
    }
    db.prepare(
      "DELETE FROM pool_host_role WHERE role <> 'worker' AND host_id IN (SELECT host_id FROM pool_host_exclusion)",
    ).run();
    projectExclusions(db, enrolledHostIds);
  })();
}

export class HostRoles {
  private readonly lookup: Database.Statement<[string]>;

  constructor(
    private readonly db: Database.Database,
    private readonly listHosts: () => Promise<
      Array<{ id: string; name: string }>
    >,
    // Called after the row is committed. It owns what a change revokes: the
    // hub token when a host loses its role or becomes a worker, the passes
    // when it stops being a worker. A role-to-role change otherwise keeps both.
    private readonly onRoleChanged: (
      hostId: string,
      previous: HostRole | null,
      next: HostRole | null,
    ) => Promise<void>,
    private readonly onChanged: () => void = () => {},
  ) {
    this.lookup = db.prepare(
      "SELECT host_id, role FROM pool_host_role WHERE host_id = ?",
    );
  }

  roleOf(hostId: string): HostRole | null {
    const row = this.lookup.get(hostId);
    return row === undefined ? null : (roleRowsSchema.parse([row])[0]?.role ?? null);
  }

  hasRole(hostId: string): boolean {
    return this.lookup.get(hostId) !== undefined;
  }

  hasAny(role: HostRole): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM pool_host_role WHERE role = ? LIMIT 1")
        .get(role) !== undefined
    );
  }

  project(enrolledHostIds: readonly string[]): void {
    projectExclusions(this.db, enrolledHostIds);
  }

  async list(): Promise<HostRoleSummary[]> {
    const hosts = await this.listHosts();
    const rows = roleRowsSchema.parse(
      this.db.prepare("SELECT host_id, role FROM pool_host_role").all(),
    );
    const roles = new Map(rows.map((row) => [row.host_id, row.role]));
    return [...new Set([...hosts.map((h) => h.id), ...roles.keys()])]
      .sort()
      .map((hostId) => {
        const host = hosts.find((h) => h.id === hostId);
        return {
          hostId,
          hostName: host?.name ?? null,
          enrolled: host !== undefined,
          role: roles.get(hostId) ?? null,
        };
      });
  }

  async set(
    input: z.infer<typeof hostRoleInputSchema>,
  ): Promise<HostRoleSummary> {
    const { hostId, role } = hostRoleInputSchema.parse(input);
    const hosts = await this.listHosts();
    const host = hosts.find((h) => h.id === hostId);
    if (role !== "none" && host === undefined)
      throw new Error(`Machine ${hostId} is not enrolled.`);
    const previous = this.roleOf(hostId);
    this.db.transaction(() => {
      if (role === "none")
        this.db
          .prepare("DELETE FROM pool_host_role WHERE host_id = ?")
          .run(hostId);
      else
        this.db
          .prepare(
            "INSERT INTO pool_host_role(host_id, role) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET role = excluded.role",
          )
          .run(hostId, role);
      this.project(hosts.map((h) => h.id));
    })();
    const next = role === "none" ? null : role;
    if (previous !== next) await this.onRoleChanged(hostId, previous, next);
    this.onChanged();
    return {
      hostId,
      hostName: host?.name ?? null,
      enrolled: host !== undefined,
      role: this.roleOf(hostId),
    };
  }
}

export const hostRoleRpcContract = defineRpcContract({
  "hostRole.list": {
    input: z.null(),
    output: z.array(hostRoleSummarySchema),
  },
  "hostRole.set": {
    input: hostRoleInputSchema,
    output: hostRoleSummarySchema,
  },
});

export function createHostRoleHandlers(
  service: HostRoles,
): PluginRpcHandlers<typeof hostRoleRpcContract> {
  return {
    "hostRole.list": () => service.list(),
    "hostRole.set": (input) => service.set(input),
  };
}

const ROLE_CHOICES = [...HOST_ROLES, "none"].join(", ");

export function createHostRoleCommands(service: HostRoles) {
  const options = {
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;
  return {
    "machine list": cliCommand({
      summary: "List machines and their Account Pooler roles",
      options,
      run: async (input) => {
        const machines = await service.list();
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify({ machines })}\n`
            : `${machines.map((h) => `${h.hostId}\t${h.hostName ?? "No longer enrolled, role kept"}\t${h.role ?? "No role"}`).join("\n")}\n`,
        };
      },
    }),
    "machine role": cliCommand({
      summary: `Set a machine's Account Pooler role (${ROLE_CHOICES}); a machine without a role gets no pooling`,
      positionals: [
        {
          name: "host-id",
          description: "Exact machine ID",
          required: true,
        },
        {
          name: "role",
          description: ROLE_CHOICES,
          required: true,
        },
      ],
      options,
      run: async (input) => {
        try {
          const role = hostRoleInputSchema.shape.role.safeParse(
            input.positionals.role,
          );
          if (!role.success)
            throw new Error(`Role must be one of ${ROLE_CHOICES}.`);
          const result = await service.set({
            hostId: input.positionals["host-id"],
            role: role.data,
          });
          return {
            exitCode: 0,
            stdout: input.options.json
              ? `${JSON.stringify({ ok: true, ...result })}\n`
              : result.role === null
                ? `Removed the Account Pooler role of ${result.hostId}; it gets no pooling.\n`
                : `Set ${result.hostId} to role ${result.role}.\n`,
          };
        } catch (error) {
          throw new PluginCliError(
            error instanceof Error ? error.message : String(error),
            { code: "pool_command_failed" },
          );
        }
      },
    }),
  };
}
