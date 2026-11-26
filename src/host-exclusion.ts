import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";

export const hostIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const hostExclusionInputSchema = z
  .object({ hostId: hostIdSchema, excluded: z.boolean() })
  .strict();
export const hostExclusionSummarySchema = z
  .object({
    hostId: hostIdSchema,
    hostName: z.string().nullable(),
    enrolled: z.boolean(),
    excluded: z.boolean(),
  })
  .strict();
export type HostExclusionSummary = z.infer<typeof hostExclusionSummarySchema>;
export class HostExcludedError extends Error {
  constructor(hostId: string) {
    super(`Machine ${hostId} is excluded from central Account Pooler routing.`);
  }
}
export class HostExclusions {
  constructor(
    private readonly db: Database.Database,
    private readonly listHosts: () => Promise<
      Array<{ id: string; name: string }>
    >,
    private readonly onChanged: () => void = () => {},
  ) {}
  isExcluded(hostId: string): boolean {
    return (
      this.db
        .prepare("SELECT host_id FROM pool_host_exclusion WHERE host_id = ?")
        .get(hostId) !== undefined
    );
  }
  async list(): Promise<HostExclusionSummary[]> {
    const hosts = await this.listHosts();
    const ids = z
      .array(z.object({ host_id: hostIdSchema }))
      .parse(this.db.prepare("SELECT host_id FROM pool_host_exclusion").all());
    return [
      ...new Set([...hosts.map((h) => h.id), ...ids.map((h) => h.host_id)]),
    ]
      .sort()
      .map((hostId) => {
        const host = hosts.find((h) => h.id === hostId);
        return {
          hostId,
          hostName: host?.name ?? null,
          enrolled: host !== undefined,
          excluded: this.isExcluded(hostId),
        };
      });
  }
  async set(
    input: z.infer<typeof hostExclusionInputSchema>,
  ): Promise<HostExclusionSummary> {
    const { hostId, excluded } = hostExclusionInputSchema.parse(input);
    const host = (await this.listHosts()).find((h) => h.id === hostId);
    if (excluded && host === undefined)
      throw new Error(`Machine ${hostId} is not enrolled.`);
    this.db.transaction(() => {
      this.db
        .prepare(
          excluded
            ? "INSERT OR IGNORE INTO pool_host_exclusion(host_id) VALUES (?)"
            : "DELETE FROM pool_host_exclusion WHERE host_id = ?",
        )
        .run(hostId);
    })();
    this.onChanged();
    return {
      hostId,
      hostName: host?.name ?? null,
      enrolled: host !== undefined,
      excluded: this.isExcluded(hostId),
    };
  }
}
export const hostExclusionRpcContract = defineRpcContract({
  "hostExclusion.list": {
    input: z.null(),
    output: z.array(hostExclusionSummarySchema),
  },
  "hostExclusion.set": {
    input: hostExclusionInputSchema,
    output: hostExclusionSummarySchema,
  },
});
export function createHostExclusionHandlers(
  service: HostExclusions,
): PluginRpcHandlers<typeof hostExclusionRpcContract> {
  return {
    "hostExclusion.list": () => service.list(),
    "hostExclusion.set": (input) => service.set(input),
  };
}
export function createHostExclusionCommands(service: HostExclusions) {
  const options = {
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;
  const mutation = (excluded: boolean) =>
    cliCommand({
      summary: `${excluded ? "Exclude" : "Include"} a machine in central Claude and Codex pooling`,
      positionals: [
        {
          name: "host-id",
          description: "Exact enrolled machine ID",
          required: true,
        },
      ],
      options,
      run: async (input) => {
        try {
          const result = await service.set({
            hostId: input.positionals["host-id"],
            excluded,
          });
          return {
            exitCode: 0,
            stdout: input.options.json
              ? `${JSON.stringify({ ok: true, ...result })}\n`
              : `${excluded ? "Excluded" : "Included"} ${result.hostId} ${excluded ? "from" : "in"} central Claude and Codex pooling.\n`,
          };
        } catch (error) {
          throw new PluginCliError(
            error instanceof Error ? error.message : String(error),
            {
              code: "pool_command_failed",
            },
          );
        }
      },
    });
  return {
    "machine list": cliCommand({
      summary: "List machine-wide central pooling exclusions",
      options,
      run: async (input) => {
        const machines = await service.list();
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify({ machines })}\n`
            : `${machines.map((h) => `${h.hostId}\t${h.hostName ?? "No longer enrolled"}\t${h.excluded ? "Excluded" : "Included"}`).join("\n")}\n`,
        };
      },
    }),
    "machine exclude": mutation(true),
    "machine include": mutation(false),
  };
}
