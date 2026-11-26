import {
  cliCommand,
  defineRpcContract,
  type BbPluginApi,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  NativePool,
  nativeCellSchema,
  nativeSubmitSchema,
} from "./native-pool.js";
const nullable = z.string().nullable();
const intent = z.object({
  id: z.string(),
  submissionKey: z.string(),
  projectId: z.string(),
  input: nullable,
  digest: z.string(),
  requestedCell: nullable,
  cellId: nullable,
  threadId: nullable,
  queueId: nullable,
  phase: z.enum([
    "waiting",
    "reserved",
    "creating",
    "bound",
    "transferring",
    "queued",
    "unknown",
    "released",
    "cancelling",
    "cancelled",
  ]),
  detail: nullable,
});
const status = z.object({
  cells: z.array(
    nativeCellSchema.extend({ enabled: z.boolean(), qualified: z.boolean() }),
  ),
  intents: z.array(intent),
  slots: z.array(
    z.object({
      cellId: z.string(),
      intentId: nullable,
      threadId: nullable,
      phase: z.enum(["free", "reserved", "resident", "draining", "unknown"]),
      epoch: nullable,
      observedAt: z.number().nullable(),
    }),
  ),
  bindings: z.array(
    z.object({
      threadId: z.string(),
      cellId: z.string(),
      generation: z.string(),
      intentId: z.string(),
    }),
  ),
  enabled: z.boolean(),
  qualified: z.boolean(),
  reconciling: z.boolean(),
});
export const nativeConfigureSchema = z
  .object({
    cellId: z.string().optional(),
    enabled: z.boolean(),
    qualified: z.boolean(),
    qualification: z.literal("installed-worker-verified").optional(),
  })
  .strict();
export const nativePoolContract = defineRpcContract({
  "native.enroll": { input: nativeCellSchema, output: status },
  "native.configure": { input: nativeConfigureSchema, output: status },
  "native.status": { input: z.null(), output: status },
  "native.submit": { input: nativeSubmitSchema, output: intent },
  "native.reconcile": { input: z.null(), output: status },
  "native.stop": {
    input: z.object({ intentId: z.string().min(1) }).strict(),
    output: intent,
  },
});
export function nativeHandlers(
  pool: NativePool,
): PluginRpcHandlers<typeof nativePoolContract> {
  return {
    "native.status": () => pool.status(),
    "native.enroll": (input) => pool.enroll(input),
    "native.configure": (input) => pool.configure(input),
    "native.submit": (input) => pool.submit(input),
    "native.reconcile": () => pool.reconcile(),
    "native.stop": (input) => pool.stop(input.intentId),
  };
}
export function registerNativeSurface(
  bb: Pick<BbPluginApi, "rpc">,
  pool: NativePool,
) {
  bb.rpc.register(nativePoolContract, nativeHandlers(pool));
}
export function createNativeCommands(pool: NativePool) {
  const output = (value: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify(value) + "\n",
  });
  return {
    "native enroll": cliCommand({
      summary: "Enroll a centrally excluded host as a disabled native cell",
      positionals: [
        {
          name: "json",
          description:
            "Cell JSON: id,hostId,generation,label,workspace,sshTarget",
          required: true,
        },
      ],
      run: async (i) =>
        output(
          await pool.enroll(
            nativeCellSchema.parse(JSON.parse(i.positionals.json!)),
          ),
        ),
    }),
    "native configure": cliCommand({
      summary:
        "Persist controller or cell state; qualification is an explicit operator assertion",
      positionals: [
        {
          name: "json",
          description:
            "JSON: optional cellId, enabled, qualified, qualification installed-worker-verified",
          required: true,
        },
      ],
      run: (i) =>
        output(
          pool.configure(
            nativeConfigureSchema.parse(JSON.parse(i.positionals.json!)),
          ),
        ),
    }),
    "native status": cliCommand({
      summary: "Show workers and durable custody",
      run: () => output(pool.status()),
    }),
    "native reconcile": cliCommand({
      summary: "Reconcile exact custody without replaying input",
      run: async () => output(await pool.reconcile()),
    }),
    "native submit": cliCommand({
      summary: "Persist a native worker submission",
      positionals: [
        {
          name: "key",
          description: "Stable submission key",
          required: true,
        },
        { name: "project", description: "Project ID", required: true },
        { name: "input", description: "Task input", required: true },
      ],
      options: {
        cell: { type: "string", description: "Optional cell ID" },
      },
      run: async (i) =>
        output(
          await pool.submit({
            submissionKey: i.positionals.key!,
            projectId: i.positionals.project!,
            input: i.positionals.input!,
            cellId: i.options.cell,
          }),
        ),
    }),
    "native stop": cliCommand({
      summary: "Interrupt an intent; retain capacity until proven safe",
      positionals: [
        { name: "intent", description: "Intent ID", required: true },
      ],
      run: async (i) => output(await pool.stop(i.positionals.intent!)),
    }),
  };
}
