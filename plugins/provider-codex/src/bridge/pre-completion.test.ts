import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  codexStopHookConfigIsClear,
  createCodexStopHook,
  type CodexStopHook,
} from "./pre-completion.js";

const hooks: CodexStopHook[] = [];
afterEach(async () => {
  await Promise.all(hooks.splice(0).map((h) => h.close()));
});
const input = {
  session_id: "provider-thread",
  turn_id: "provider-turn",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: "Need a choice",
};
const run = {
  id: "native-run",
  eventName: "stop",
  source: "sessionFlags",
  sourcePath: "/<session-flags>/config.toml",
  displayOrder: 0,
  executionMode: "sync",
  handlerType: "command",
};
async function fixture(
  request: Parameters<typeof createCodexStopHook>[0]["request"] = vi.fn(
    async () => ({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "continue",
            instruction: "Ask natively",
          }),
        },
      ],
    }),
  ),
) {
  const identity = {
    threadId: "provider-thread",
    openTurnIds: new Set(["provider-turn"]),
    live: true,
  };
  const hook = await createCodexStopHook({ identity: () => identity, request });
  hooks.push(hook);
  const flag = hook.launchArgs[3];
  const command = JSON.parse(
    flag.slice(flag.indexOf("command=") + 8, flag.indexOf(",timeout=")),
  );
  const listing = {
    data: [
      {
        warnings: [],
        errors: [],
        hooks: [
          {
            key: "/<session-flags>/config.toml:stop:0:0",
            command,
            currentHash: "sha256:" + "a".repeat(64),
            eventName: "stop",
            enabled: true,
            trustStatus: "trusted",
            source: "sessionFlags",
            sourcePath: run.sourcePath,
            displayOrder: 0,
          },
        ],
      },
    ],
  };
  const config = await hook.trustConfig(
    async (method) =>
      method === "config/read"
        ? {
            layers: [
              {
                name: { type: "sessionFlags" },
                config: {
                  hooks: {
                    Stop: [
                      { hooks: [{ type: "command", command, timeout: 4 }] },
                    ],
                  },
                },
              },
            ],
          }
        : listing,
    "/fixture",
  );
  await hook.verify(async () => listing, identity.threadId);
  const call = (value = input) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("exit", () => resolve(output));
      child.stdin.end(JSON.stringify(value));
    });
  const started = (id = "native-run") =>
    hook.notification("hook/started", {
      threadId: identity.threadId,
      turnId: "provider-turn",
      run: { ...run, id },
    });
  return { hook, request, identity, call, started, command, listing, config };
}
it("uses a private command and trusts only its discovered declaration", async () => {
  const f = await fixture();
  expect(f.config).toMatchObject({
    hooks: {
      Stop: [{ hooks: [{ type: "command", timeout: 4 }] }],
      state: {
        "/<session-flags>/config.toml:stop:0:0": {
          trusted_hash: "sha256:" + "a".repeat(64),
        },
      },
    },
  });
  await expect(
    f.hook.verify(async () => ({ data: [] }), "provider-thread"),
  ).rejects.toThrow("not trusted");
});
it("executes the actual hook client, bounds text, maps exact origin and refuses replay", async () => {
  const f = await fixture();
  f.started();
  expect(
    JSON.parse(
      await f.call({ ...input, last_assistant_message: "Ж".repeat(9000) }),
    ),
  ).toEqual({ decision: "block", reason: "Ask natively" });
  expect(f.request).toHaveBeenCalledWith(
    "provider-turn",
    { finalText: "Ж".repeat(8192), truncated: true },
    expect.any(AbortSignal),
  );
  f.started();
  expect(JSON.parse(await f.call())).toEqual({});
  expect(f.request).toHaveBeenCalledTimes(1);
});
it("rejects calls without native Stop, foreign session/turn and recursive corrections", async () => {
  const f = await fixture();
  expect(JSON.parse(await f.call())).toEqual({});
  f.started();
  expect(JSON.parse(await f.call({ ...input, session_id: "foreign" }))).toEqual(
    {},
  );
  expect(JSON.parse(await f.call({ ...input, turn_id: "foreign" }))).toEqual(
    {},
  );
  expect(
    JSON.parse(await f.call({ ...input, stop_hook_active: true })),
  ).toEqual({});
  expect(f.request).not.toHaveBeenCalled();
});
it("ignores model-origin and foreign native hook notifications", async () => {
  const f = await fixture();
  f.hook.notification("item/tool/call", {
    threadId: "provider-thread",
    turnId: "provider-turn",
    run,
  });
  f.hook.notification("hook/started", {
    threadId: "provider-thread",
    turnId: "provider-turn",
    run: { ...run, source: "project" },
  });
  expect(JSON.parse(await f.call())).toEqual({});
  expect(f.request).not.toHaveBeenCalled();
});
it("cancels in-flight policy and prevents a late block after Stop", async () => {
  let resolve!: (r: unknown) => void;
  const request = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
  const f = await fixture(request);
  f.started();
  const result = f.call();
  await vi.waitFor(() => expect(request).toHaveBeenCalled());
  f.hook.cancel();
  resolve({
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: '{"action":"continue","instruction":"too late"}',
      },
    ],
  });
  expect(JSON.parse(await result)).toEqual({});
  f.started("late-run");
  expect(JSON.parse(await f.call())).toEqual({});
});
it("fails open when identity ends during policy and on malformed policy", async () => {
  const f = await fixture(
    vi.fn(async () => {
      f.identity.openTurnIds.clear();
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: '{"action":"continue","instruction":"late"}',
          },
        ],
      };
    }),
  );
  f.started();
  expect(JSON.parse(await f.call())).toEqual({});
});
it("bounds IPC authentication and client lifetime", async () => {
  const f = await fixture();
  f.started();
  const script = await readFile(f.command.split("'")[3], "utf8");
  const path = JSON.parse(/path=(".*");/.exec(script)![1]);
  const send = (data: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(path);
      let output = "";
      socket.on("error", () => resolve(output));
      socket.on("data", (b) => (output += b));
      socket.on("close", () => resolve(output));
      socket.on("connect", () => socket.write(data));
    });
  expect(await send(JSON.stringify({ token: "forged", input }) + "\n")).toBe(
    "{}\n",
  );
  expect(await send("x".repeat(128 * 1024 + 1))).toBe("");
  expect(f.request).not.toHaveBeenCalled();
});
it("fails open at the deadline even if policy never settles", async () => {
  const f = await fixture(vi.fn(() => new Promise<never>(() => {})));
  f.started();
  expect(JSON.parse(await f.call())).toEqual({});
}, 5000);

it("fails open on malformed, error and overlong policy replies", async () => {
  for (const response of [
    { success: false, contentItems: [] },
    {
      success: true,
      contentItems: [{ type: "inputText", text: "invalid JSON" }],
    },
    {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "continue",
            instruction: "x".repeat(1001),
          }),
        },
      ],
    },
  ]) {
    const f = await fixture(vi.fn(async () => response));
    f.started();
    expect(JSON.parse(await f.call())).toEqual({});
  }
});

it.each(["sessionFlags", "user", "project", "system", "enterpriseManaged"])(
  "refuses existing hooks or trust state in %s before launch injection",
  async (type) => {
    for (const hooks of [
      { Stop: [{ hooks: [{ type: "command", command: "existing" }] }] },
      { state: { existing: { trusted_hash: "preserve" } } },
    ]) {
      const request = vi.fn(async () => ({
        layers: [{ name: { type }, config: { hooks } }],
      }));
      expect(await codexStopHookConfigIsClear(request, "/fixture")).toBe(false);
      expect(request).toHaveBeenCalledExactlyOnceWith("config/read", {
        cwd: "/fixture",
        includeLayers: true,
      });
    }
  },
);
it("refuses unknown layers, discovery errors and hooks discovered outside TOML layers", async () => {
  for (const response of [
    null,
    { layers: null },
    { layers: [] },
    { layers: [{ name: { type: "unknown-future-layer" }, config: {} }] },
    { layers: [{ name: { type: "user" }, config: null }] },
  ]) {
    expect(
      await codexStopHookConfigIsClear(async () => response, "/fixture"),
    ).toBe(false);
  }
  for (const data of [
    { hooks: [{}], warnings: [], errors: [] },
    { hooks: [], warnings: ["unreadable hooks.json"], errors: [] },
    { hooks: [], warnings: [], errors: ["invalid hook"] },
  ]) {
    expect(
      await codexStopHookConfigIsClear(
        async (method) =>
          method === "config/read"
            ? { layers: [{ name: { type: "user" }, config: {} }] }
            : { data: [data] },
        "/fixture",
      ),
    ).toBe(false);
  }
});
it("rechecks all source layers before replacing session-local trust configuration", async () => {
  const f = await fixture();
  const existing = { state: { old: { trusted_hash: "keep" } } };
  for (const type of ["sessionFlags", "user", "project"]) {
    await expect(
      f.hook.trustConfig(
        async () => ({
          layers: [{ name: { type }, config: { hooks: existing } }],
        }),
        "/fixture",
      ),
    ).rejects.toThrow("Conflicting or unknown");
  }
  expect(existing).toEqual({ state: { old: { trusted_hash: "keep" } } });
});
it("permits known empty source layers with clean discovery", async () => {
  expect(
    await codexStopHookConfigIsClear(
      async (method) =>
        method === "config/read"
          ? {
              layers: [
                { name: { type: "user" }, config: {} },
                {
                  name: { type: "sessionFlags" },
                  config: { model: "fixture" },
                },
              ],
            }
          : { data: [{ hooks: [], warnings: [], errors: [] }] },
      "/fixture",
    ),
  ).toBe(true);
});

it.each([
  "packagedDefaults",
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
  "legacyManagedConfigTomlFromFile",
  "legacyManagedConfigTomlFromMdm",
])(
  "preserves explicit hooks opt-out in %s even beneath session flags",
  async (type) => {
    const f = await fixture();
    const disabled = {
      name: { type },
      config: { features: { hooks: false } },
      disabledReason: "inactive layer",
    };
    const request = async (method: string) =>
      method === "config/read"
        ? {
            layers: [
              disabled,
              {
                name: { type: "sessionFlags" },
                config: { features: { hooks: true } },
              },
            ],
          }
        : { data: [{ hooks: [], warnings: [], errors: [] }] };
    expect(await codexStopHookConfigIsClear(request, "/fixture")).toBe(false);
    await expect(f.hook.trustConfig(request, "/fixture")).rejects.toThrow(
      "Conflicting or unknown",
    );
    expect(disabled.config.features.hooks).toBe(false);
  },
);
it.each([{}, { hooks: true }])(
  "permits clean default/enabled hook features: %j",
  async (features) => {
    expect(
      await codexStopHookConfigIsClear(
        async (method) =>
          method === "config/read"
            ? { layers: [{ name: { type: "user" }, config: { features } }] }
            : { data: [{ hooks: [], warnings: [], errors: [] }] },
        "/fixture",
      ),
    ).toBe(true);
  },
);
