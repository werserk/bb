import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCodexAppServerConnection } from "./app-server-connection.js";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import { FULL_ACCESS_SESSION_OPTIONS } from "./fake-codex-app-server-harness.js";

afterEach(() => vi.unstubAllEnvs());

it
  .runIf(process.env.BB_CODEX_NATIVE_STOP_FIXTURE === "1")
  .each([
    "continue",
    "cancel",
    "optout-launch",
    "optout-user",
    "existing-launch-enabled",
    "existing-launch-disabled",
    "existing-user-enabled",
    "existing-user-disabled",
  ])(
  "installed Codex preserves Stop custody and continuity: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "bb-native-stop-"));
    await mkdir(join(root, "home"));
    let requests = 0;
    const prompts: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (!req.url?.endsWith("/responses")) {
          res.writeHead(404);
          res.end();
          return;
        }
        prompts.push(body);
        requests++;
        const item = {
          type: "message",
          id: `msg-${requests}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text:
                requests === 1
                  ? "Need your choice"
                  : "Finished after native correction",
              annotations: [],
            },
          ],
        };
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "close",
        });
        const emit = (type: string, data: object) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        emit("response.created", {
          response: {
            id: `resp-${requests}`,
            object: "response",
            status: "in_progress",
            output: [],
          },
        });
        emit("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", {
          response: {
            id: `resp-${requests}`,
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        });
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", "codex");
    vi.stubEnv(
      "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
      JSON.stringify([
        "app-server",
        "-c",
        'model_provider="fixture"',
        "-c",
        'model="gpt-5.4"',
        "-c",
        'model_providers.fixture.name="Fixture"',
        "-c",
        `model_providers.fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
        "-c",
        'model_providers.fixture.wire_api="responses"',
        "-c",
        "model_providers.fixture.requires_openai_auth=false",
      ]),
    );
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "");
    vi.stubEnv("CODEX_HOME", join(root, "home"));
    const conflicting = mode.startsWith("existing-");
    const marker = join(root, "existing-hook-ran");
    const userConfig = join(root, "home", "config.toml");
    let userConfigBefore: string | null = null;
    const optedOut = mode.startsWith("optout-");
    if (mode === "optout-user") {
      userConfigBefore = "features.hooks=false\n";
      await writeFile(userConfig, userConfigBefore);
    } else if (mode === "optout-launch") {
      const launchArgs = z
        .array(z.string())
        .parse(JSON.parse(process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS!));
      launchArgs.push("-c", "features.hooks=false");
      vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_ARGS", JSON.stringify(launchArgs));
    }
    if (conflicting) {
      const client = join(root, "existing-hook.cjs");
      await writeFile(
        client,
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'ran\\n');process.stdout.write('{}');`,
      );
      const command = `'${process.execPath}' '${client}'`;
      const stop = `[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=4}]}]`;
      const launchArgs = z
        .array(z.string())
        .parse(JSON.parse(process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS!));
      if (mode.startsWith("existing-user")) {
        await writeFile(
          userConfig,
          `features.hooks=true\n[hooks]\nStop=${stop}\n`,
        );
      } else {
        launchArgs.push(
          "-c",
          "features.hooks=true",
          "-c",
          `hooks.Stop=${stop}`,
        );
      }
      const probe = createCodexAppServerConnection({
        command: "codex",
        args: launchArgs,
        cwd: root,
        env: process.env,
        recordThreadId: null,
        onNotification: () => {},
        onRequest: (_m, _p, r) => r.error(-32601, "fixture"),
        onExit: () => {},
      });
      try {
        await probe.request({
          method: "initialize",
          params: {
            clientInfo: { name: "bb-fixture", version: "1" },
            capabilities: { experimentalApi: true },
          },
          resultSchema: z.unknown(),
        });
        const listing = await probe.request({
          method: "hooks/list",
          params: { cwds: [root] },
          resultSchema: z.object({
            data: z.array(
              z.object({
                hooks: z.array(
                  z.object({ key: z.string(), currentHash: z.string() }),
                ),
              }),
            ),
          }),
        });
        const existing = listing.data[0].hooks[0];
        if (mode.startsWith("existing-user")) {
          userConfigBefore =
            (await readFile(userConfig, "utf8")) +
            `[hooks.state.${JSON.stringify(existing.key)}]\ntrusted_hash=${JSON.stringify(existing.currentHash)}\n`;
          await writeFile(userConfig, userConfigBefore);
        } else {
          launchArgs.push(
            "-c",
            `hooks.state={${JSON.stringify(existing.key)}={trusted_hash=${JSON.stringify(existing.currentHash)}}}`,
          );
        }
      } finally {
        await probe.kill();
      }
      vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_ARGS", JSON.stringify(launchArgs));
    }
    const bridge = createHarness(handleLine);
    let releasedProviderThreadId = "unstarted";
    try {
      bridge.sendRequest(1, "thread/start", {
        threadId: "bb-native-stop",
        cwd: root,
        instructionMode: "append",
        options: FULL_ACCESS_SESSION_OPTIONS,
      });
      const start = await bridge.waitForResponse(1);
      expect(start.error).toBeUndefined();
      const { providerThreadId } = start.result as { providerThreadId: string };
      releasedProviderThreadId = providerThreadId;
      bridge.sendRequest(2, "turn/start", {
        threadId: "bb-native-stop",
        providerThreadId,
        input: [{ type: "text", text: "Fixture response", mentions: [] }],
        clientRequestId: "creq_a2b3c4d5e6",
        options: FULL_ACCESS_SESSION_OPTIONS,
      });
      if (conflicting || optedOut) {
        let policyCalls = 0;
        await vi.waitFor(
          () => {
            for (const call of bridge.messages.filter(
              (m) => m.method === "item/tool/call",
            )) {
              policyCalls++;
              handleLine(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: call.id,
                  result: {
                    success: true,
                    contentItems: [
                      {
                        type: "inputText",
                        text: JSON.stringify(
                          mode.endsWith("enabled")
                            ? {
                                action: "continue",
                                instruction: "Ask natively",
                              }
                            : { action: "allow" },
                        ),
                      },
                    ],
                  },
                }),
              );
            }
            expect(
              bridge.messages
                .flatMap(
                  (m) =>
                    (
                      m.params as
                        | { deltas?: Array<{ kind: string }> }
                        | undefined
                    )?.deltas ?? [],
                )
                .some((d) => d.kind === "turn.boundary"),
            ).toBe(true);
          },
          { timeout: 15000 },
        );
        expect(policyCalls).toBe(0);
        if (conflicting) expect(await readFile(marker, "utf8")).toBe("ran\n");
        expect(requests).toBe(1);
        const configWarnings = bridge.messages
          .flatMap(
            (m) =>
              (
                m.params as
                  | { deltas?: Array<{ kind: string; category?: string }> }
                  | undefined
              )?.deltas ?? [],
          )
          .filter(
            (d) => d.kind === "provider.warning" && d.category === "config",
          );
        expect(configWarnings).toEqual([]);
        if (userConfigBefore !== null)
          expect(await readFile(userConfig, "utf8")).toBe(userConfigBefore);
        return;
      }
      await vi.waitFor(
        () =>
          expect(
            bridge.messages.some((m) => m.method === "item/tool/call"),
          ).toBe(true),
        { timeout: 20000 },
      );
      const call = bridge.messages.find((m) => m.method === "item/tool/call")!;
      expect(call.params).toMatchObject({
        tool: "bb_internal_pre_completion",
        threadId: "bb-native-stop",
        providerThreadId,
        arguments: { finalText: "Need your choice", truncated: false },
      });
      if (mode === "cancel") {
        bridge.sendRequest(4, "thread/stop", {
          threadId: "bb-native-stop",
          providerThreadId,
          intent: "interrupt",
          activeTurnId: (call.params as { turnId: string }).turnId,
        });
        expect((await bridge.waitForResponse(4)).error).toBeUndefined();
        handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: {
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text: '{"action":"continue","instruction":"late correction"}',
                },
              ],
            },
          }),
        );
        await vi.waitFor(() =>
          expect(JSON.stringify(bridge.messages)).toContain(
            '"status":"interrupted"',
          ),
        );
        expect(requests).toBe(1);
        return;
      }
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: '{"action":"continue","instruction":"Use the native question form"}',
              },
            ],
          },
        }),
      );
      await vi.waitFor(() => expect(requests).toBe(2), { timeout: 10000 });
      await vi.waitFor(
        () =>
          expect(
            bridge.messages
              .flatMap(
                (m) =>
                  (m.params as { deltas?: Array<{ kind: string }> } | undefined)
                    ?.deltas ?? [],
              )
              .some((d) => d.kind === "turn.boundary"),
          ).toBe(true),
        { timeout: 10000 },
      );
      const deltas = bridge.messages.flatMap(
        (m) =>
          (
            m.params as
              | { deltas?: Array<{ kind: string; providerTurnId?: string }> }
              | undefined
          )?.deltas ?? [],
      );
      const opens = deltas.filter((d) => d.kind === "turn.open");
      const ends = deltas.filter((d) => d.kind === "turn.boundary");
      expect(opens).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(call.params).toMatchObject({ turnId: opens[0].providerTurnId });
      expect(ends[0].providerTurnId).toBe(opens[0].providerTurnId);
      expect(
        bridge.messages.filter((m) => m.method === "item/tool/call"),
      ).toHaveLength(1);
      expect(prompts[1]).toContain("Use the native question form");
    } finally {
      bridge.sendRequest(3, "thread/stop", {
        threadId: "bb-native-stop",
        intent: "release",
        providerThreadId: releasedProviderThreadId,
        activeTurnId: null,
      });
      expect((await bridge.waitForResponse(3)).error).toBeUndefined();
      bridge.restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
