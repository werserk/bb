import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { JsonValue } from "../generated/codex-app-server/schema/serde_json/JsonValue.js";
import { z } from "zod";
import { experimental_PRE_COMPLETION_LIMITS as limits } from "@get-bb/plugin-sdk/provider-bridge";

const hookSchema = z.object({
  session_id: z.string().min(1).max(256),
  turn_id: z.string().min(1).max(256),
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().nullable(),
});
const notificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  run: z.object({
    id: z.string(),
    eventName: z.literal("stop"),
    source: z.literal("sessionFlags"),
    sourcePath: z.string(),
    displayOrder: z.number(),
    executionMode: z.literal("sync"),
    handlerType: z.literal("command"),
  }),
});
const listingSchema = z.object({
  data: z.array(
    z.object({
      hooks: z.array(
        z.object({
          key: z.string(),
          command: z.string().nullable(),
          currentHash: z.string(),
          eventName: z.string(),
          enabled: z.boolean(),
          trustStatus: z.string(),
          source: z.string(),
          sourcePath: z.string(),
          displayOrder: z.number(),
        }),
      ),
    }),
  ),
});
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }),
  z.object({
    action: z.literal("continue"),
    instruction: z.string().trim().min(1).max(limits.instructionLimit),
  }),
]);
const MAX_BYTES = 128 * 1024;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

type Request = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

const configLayersSchema = z.object({
  layers: z
    .array(
      z.object({
        name: z.object({
          type: z.enum([
            "packagedDefaults",
            "mdm",
            "system",
            "enterpriseManaged",
            "user",
            "project",
            "sessionFlags",
            "legacyManagedConfigTomlFromFile",
            "legacyManagedConfigTomlFromMdm",
          ]),
        }),
        config: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});
const featuresSchema = z.object({ hooks: z.boolean().optional() });
const discoverySchema = z.object({
  data: z
    .array(
      z.object({
        hooks: z.array(z.unknown()),
        warnings: z.array(z.string()),
        errors: z.array(z.string()),
      }),
    )
    .length(1),
});

export async function codexStopHookConfigIsClear(
  request: Request,
  cwd: string,
  own?: { command: string; hooks: JsonValue },
): Promise<boolean> {
  try {
    const config = configLayersSchema.parse(
      await request("config/read", { cwd, includeLayers: true }),
    );
    for (const layer of config.layers) {
      if (Object.hasOwn(layer.config, "features")) {
        const features = featuresSchema.safeParse(layer.config.features);
        if (!features.success || features.data.hooks === false) return false;
      }
      if (!Object.hasOwn(layer.config, "hooks")) continue;
      if (
        !own ||
        layer.name.type !== "sessionFlags" ||
        !isDeepStrictEqual(layer.config.hooks, own.hooks)
      )
        return false;
    }
    const listing = discoverySchema.parse(
      await request("hooks/list", { cwds: [cwd] }),
    );
    const ownListing = own ? listingSchema.safeParse(listing) : null;
    for (const entry of listing.data) {
      if (entry.errors.length || entry.warnings.length) return false;
      if (!own && entry.hooks.length) return false;
      if (
        own &&
        (entry.hooks.length !== 1 ||
          !ownListing?.success ||
          ownListing.data.data[0].hooks[0].command !== own.command)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function createCodexStopHook(args: {
  identity: () => {
    threadId: string | null;
    openTurnIds: ReadonlySet<string>;
    live: boolean;
  };
  request: (
    turnId: string,
    input: { finalText: string; truncated: boolean },
    signal: AbortSignal,
  ) => Promise<unknown>;
}) {
  if (process.platform === "win32")
    throw new Error("Codex Stop IPC requires Unix sockets");
  const root = await mkdtemp(join(tmpdir(), "bb-stop-"));
  const path = join(root, "ipc");
  const token = randomBytes(32).toString("hex");
  const client = join(root, "hook.cjs");
  const command = `${quote(process.execPath)} ${quote(client)}`;
  const declaration = {
    Stop: [{ hooks: [{ type: "command", command, timeout: 4 }] }],
  };
  let retired = false;
  let source: { path: string; order: number } | null = null;
  const runs = new Map<string, { threadId: string; turnId: string }>();
  const consumed = new Set<string>();
  const stoppedTurns = new Set<string>();
  const controllers = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 8 || retired) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(limits.bridgeDeadlineMs + 500, () => socket.destroy());
    let chunks = "";
    const decoder = new StringDecoder("utf8");
    let size = 0;
    let received = false;
    socket.on("data", (chunk: Buffer) => {
      if (received) {
        socket.destroy();
        return;
      }
      size += chunk.length;
      if (size > MAX_BYTES) {
        socket.destroy();
        return;
      }
      chunks += decoder.write(chunk);
      if (!chunks.includes("\n")) return;
      received = true;
      void respond(chunks, socket);
    });
  });
  async function respond(raw: string, socket: Socket) {
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => controller.abort();
    socket.once("close", cancel);
    const timer = setTimeout(cancel, limits.bridgeDeadlineMs);
    const allow = {};
    let output: object = allow;
    try {
      const envelope = z
        .object({ token: z.literal(token), input: hookSchema })
        .parse(JSON.parse(raw));
      const input = envelope.input;
      const identity = args.identity();
      const run = [...runs.entries()].find(
        ([, run]) =>
          run.threadId === input.session_id && run.turnId === input.turn_id,
      );
      if (
        retired ||
        !identity.live ||
        identity.threadId !== input.session_id ||
        !identity.openTurnIds.has(input.turn_id) ||
        stoppedTurns.has(input.turn_id) ||
        !run ||
        consumed.has(run[0])
      )
        return;
      consumed.add(run[0]);
      runs.delete(run[0]);
      if (input.stop_hook_active) return;
      const text = input.last_assistant_message ?? "";
      const response = await Promise.race([
        args.request(
          input.turn_id,
          {
            finalText: text.slice(0, limits.finalTextLimit),
            truncated: text.length > limits.finalTextLimit,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        ),
      ]);
      const parsed = z
        .object({
          success: z.boolean(),
          contentItems: z.array(
            z.object({ type: z.string(), text: z.string().optional() }),
          ),
        })
        .parse(response);
      if (!parsed.success) return;
      const decision = decisionSchema.parse(
        JSON.parse(
          parsed.contentItems
            .filter((i) => i.type === "inputText")
            .map((i) => i.text ?? "")
            .join("\n"),
        ),
      );
      const latest = args.identity();
      if (
        !retired &&
        !controller.signal.aborted &&
        latest.live &&
        latest.threadId === input.session_id &&
        latest.openTurnIds.has(input.turn_id) &&
        decision.action === "continue"
      ) {
        output = { decision: "block", reason: decision.instruction };
      }
    } catch {
      output = allow;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      socket.off("close", cancel);
      if (!socket.destroyed) socket.end(JSON.stringify(output) + "\n");
    }
  }
  try {
    await writeFile(
      client,
      `const net=require('node:net');
const token=${JSON.stringify(token)},path=${JSON.stringify(path)};
let data='',size=0,done=false;
const finish=(output)=>{if(done)return;done=true;process.stdout.write(output);process.exit(0)};
const timer=setTimeout(()=>finish('{}'),${limits.bridgeDeadlineMs + 500});
process.stdin.on('data',chunk=>{size+=chunk.length;if(size>${MAX_BYTES})finish('{}');data+=chunk});
process.stdin.on('end',()=>{try{const input=JSON.parse(data);if(typeof input.last_assistant_message==='string'&&input.last_assistant_message.length>${limits.finalTextLimit}){input.last_assistant_message=input.last_assistant_message.slice(0,${limits.finalTextLimit + 1})}const s=net.connect(path);let response='';s.on('connect',()=>s.write(JSON.stringify({token,input})+'\\n'));s.on('data',chunk=>{response+=chunk;if(response.length>8192)finish('{}');if(response.includes('\\n'))finish(response)});s.on('error',()=>finish('{}'));s.on('end',()=>finish('{}'))}catch{finish('{}')}});
`,
      { mode: 0o600 },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    launchArgs: [
      "-c",
      "features.hooks=true",
      "-c",
      `hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=4}]}]`,
    ],
    async trustConfig(
      request: Request,
      cwd: string,
    ): Promise<Record<string, JsonValue>> {
      if (
        !(await codexStopHookConfigIsClear(request, cwd, {
          command,
          hooks: declaration,
        }))
      )
        throw new Error("Conflicting or unknown Codex hook configuration");
      const listing = listingSchema.parse(
        await request("hooks/list", { cwds: [cwd] }),
      );
      const hook = listing.data
        .flatMap((d) => d.hooks)
        .find(
          (h) =>
            h.source === "sessionFlags" &&
            h.eventName === "stop" &&
            h.command === command &&
            h.enabled,
        );
      if (!hook || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash))
        throw new Error("Codex Stop hook discovery unavailable");
      source = { path: hook.sourcePath, order: hook.displayOrder };
      return {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command, timeout: 4 }] }],
          state: { [hook.key]: { trusted_hash: hook.currentHash } },
        },
      };
    },
    async verify(request: Request, threadId: string) {
      const listing = listingSchema.parse(
        await request("hooks/list", { threadId }),
      );
      const trusted = listing.data
        .flatMap((d) => d.hooks)
        .find(
          (h) =>
            h.command === command &&
            h.source === "sessionFlags" &&
            h.eventName === "stop" &&
            h.enabled &&
            h.trustStatus === "trusted",
        );
      if (!trusted) throw new Error("Codex Stop hook is not trusted");
      source = { path: trusted.sourcePath, order: trusted.displayOrder };
    },
    notification(method: string, params: unknown) {
      if (method !== "hook/started" && method !== "hook/completed") return;
      const parsed = notificationSchema.safeParse(params);
      if (
        !parsed.success ||
        !source ||
        parsed.data.run.sourcePath !== source.path ||
        parsed.data.run.displayOrder !== source.order
      )
        return;
      const { run, threadId, turnId } = parsed.data;
      const identity = args.identity();
      if (
        !identity.live ||
        identity.threadId !== threadId ||
        !identity.openTurnIds.has(turnId) ||
        stoppedTurns.has(turnId)
      )
        return;
      if (consumed.size >= 128) return;
      if (method === "hook/started" && !consumed.has(run.id) && runs.size < 8)
        runs.set(run.id, { threadId, turnId });
      if (method === "hook/completed") runs.delete(run.id);
    },
    settle(turnId: string) {
      stoppedTurns.delete(turnId);
      for (const [id, run] of runs) if (run.turnId === turnId) runs.delete(id);
      if (args.identity().openTurnIds.size === 0) consumed.clear();
    },
    cancel() {
      for (const id of args.identity().openTurnIds) stoppedTurns.add(id);
      for (const c of controllers) c.abort();
      runs.clear();
    },
    async close() {
      retired = true;
      for (const c of controllers) c.abort();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type CodexStopHook = Awaited<ReturnType<typeof createCodexStopHook>>;
