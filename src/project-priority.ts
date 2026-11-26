import {
  PluginCliError,
  cliCommand,
  defineRpcContract,
  type PluginCliResult,
  type PluginKvStorage,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Account } from "./contracts.js";

export const PROJECT_HEADER = "x-bb-project";
export const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

const KEY_PREFIX = "project-priority:";

export const projectIdSchema = z.string().regex(/^proj_[a-z0-9]+$/u);

const orderedAccountIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Account ids must be unique.",
  });

const projectPriorityEntrySchema = z
  .object({ projectId: projectIdSchema, accountIds: orderedAccountIdsSchema })
  .strict();

const projectIdInputSchema = z.object({ projectId: projectIdSchema }).strict();

export type ProjectPriorityEntry = z.infer<typeof projectPriorityEntrySchema>;

export function readProjectId(headers: Headers): string | null {
  const value = headers.get(PROJECT_HEADER)?.trim();
  if (value === undefined) return null;
  const parsed = projectIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function orderForProject<T extends { id: string }>(
  accounts: readonly T[],
  projectOrder: readonly string[],
): T[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const first = projectOrder.flatMap((id) => {
    const account = byId.get(id);
    return account === undefined ? [] : [account];
  });
  const listed = new Set(first.map((account) => account.id));
  return [...first, ...accounts.filter((account) => !listed.has(account.id))];
}

export function projectHeaderValue(
  projectId: string | null,
  existing: string | undefined,
): string | null {
  const parsed = projectIdSchema.safeParse(projectId);
  if (!parsed.success) return null;
  const kept = (existing ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.toLowerCase().startsWith(`${PROJECT_HEADER}:`),
    );
  return [...kept, `${PROJECT_HEADER}: ${parsed.data}`].join("\n");
}

export class ProjectPriority {
  private readonly orders = new Map<string, readonly string[]>();

  constructor(
    private readonly kv: PluginKvStorage,
    private readonly listAccounts: () => Promise<Account[]>,
    private readonly onChanged: () => void = () => {},
  ) {}

  async load(): Promise<void> {
    this.orders.clear();
    for (const key of await this.kv.list(KEY_PREFIX)) {
      const parsed = projectPriorityEntrySchema.safeParse({
        projectId: key.slice(KEY_PREFIX.length),
        accountIds: await this.kv.get(key),
      });
      if (parsed.success) {
        this.orders.set(parsed.data.projectId, parsed.data.accountIds);
      }
    }
  }

  get(projectId: string): readonly string[] | null {
    return this.orders.get(projectId) ?? null;
  }

  list(): ProjectPriorityEntry[] {
    return [...this.orders]
      .map(([projectId, accountIds]) => ({
        projectId,
        accountIds: [...accountIds],
      }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  async set(input: ProjectPriorityEntry): Promise<ProjectPriorityEntry> {
    const entry = projectPriorityEntrySchema.parse(input);
    const known = new Set(
      (await this.listAccounts())
        .filter((account) => account.provider === "claude")
        .map((account) => account.id),
    );
    const unknown = entry.accountIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown Claude account id: ${unknown.join(", ")}.`);
    }
    await this.kv.set(`${KEY_PREFIX}${entry.projectId}`, entry.accountIds);
    this.orders.set(entry.projectId, entry.accountIds);
    this.onChanged();
    return entry;
  }

  async clear(projectId: string): Promise<boolean> {
    const id = projectIdSchema.parse(projectId);
    const existed = this.orders.delete(id);
    await this.kv.delete(`${KEY_PREFIX}${id}`);
    if (existed) this.onChanged();
    return existed;
  }
}

export const projectPriorityRpcContract = defineRpcContract({
  "projectPriority.list": {
    input: z.null(),
    output: z.array(projectPriorityEntrySchema),
  },
  "projectPriority.set": {
    input: projectPriorityEntrySchema,
    output: projectPriorityEntrySchema,
  },
  "projectPriority.clear": {
    input: projectIdInputSchema,
    output: z.object({ cleared: z.boolean() }).strict(),
  },
});

export function createProjectPriorityHandlers(
  service: ProjectPriority,
): PluginRpcHandlers<typeof projectPriorityRpcContract> {
  return {
    "projectPriority.list": () => service.list(),
    "projectPriority.set": (input) => service.set(input),
    "projectPriority.clear": async ({ projectId }) => ({
      cleared: await service.clear(projectId),
    }),
  };
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const PROJECT_POSITIONAL = {
  name: "project-id",
  description: "bb project id, for example proj_abc123",
  required: true,
} as const;

function json(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function attempt(
  work: () => Promise<PluginCliResult>,
): Promise<PluginCliResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(
      error instanceof Error ? error.message : String(error),
      { code: "pool_command_failed" },
    );
  }
}

export function createProjectPriorityCommands(service: ProjectPriority) {
  return {
    "project-priority list": cliCommand({
      summary: "List per-project Claude account priority orders",
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const entries = service.list();
          return {
            exitCode: 0,
            stdout: input.options.json
              ? json({ projects: entries })
              : entries.length === 0
                ? "No project priorities configured.\n"
                : `${entries.map((entry) => `${entry.projectId}: ${entry.accountIds.join(" > ")}`).join("\n")}\n`,
          };
        }),
    }),
    "project-priority set": cliCommand({
      summary: "Set the Claude account order for one project's new sessions",
      description:
        "Listed accounts are tried first, in order; every other account follows by global priority. Live session pins are never moved. Projects without an order keep the global order.",
      positionals: [
        PROJECT_POSITIONAL,
        {
          name: "account-id",
          description: "Claude account UUIDs from `bb pool account list`",
          required: true,
          variadic: true,
        },
      ],
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const entry = await service.set({
            projectId: input.positionals["project-id"],
            accountIds: input.positionals["account-id"],
          });
          return {
            exitCode: 0,
            stdout: input.options.json
              ? json({ ok: true, ...entry })
              : `Set ${entry.projectId} order: ${entry.accountIds.join(" > ")}.\n`,
          };
        }),
    }),
    "project-priority clear": cliCommand({
      summary: "Remove one project's account order",
      positionals: [PROJECT_POSITIONAL],
      options: { json: JSON_OPTION },
      run: (input) =>
        attempt(async () => {
          const projectId = input.positionals["project-id"];
          const cleared = await service.clear(projectId);
          return {
            exitCode: 0,
            stdout: input.options.json
              ? json({ ok: true, projectId, cleared })
              : cleared
                ? `Cleared ${projectId} order.\n`
                : `${projectId} had no order.\n`,
          };
        }),
    }),
  };
}
