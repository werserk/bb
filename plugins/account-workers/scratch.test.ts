import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRefusal } from "./confine.js";
import { PROFILES } from "./profiles/index.js";
import type { ProviderProfile } from "./profiles/types.js";
import { prepareScratch, releaseScratch, scratchBase, verifyProfile } from "./scratch.js";
import { TOOL_NAMES } from "./tools.js";

let state: string;
beforeEach(async () => {
  state = await mkdtemp(path.join(tmpdir(), "aw-state-"));
  vi.stubEnv("XDG_STATE_HOME", state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(state, { recursive: true, force: true });
});

const base = () => path.join(state, "bb-account-workers/scratch");

function withProfile(profile: ProviderProfile) {
  (PROFILES as ProviderProfile[]).push(profile);
  return () => (PROFILES as ProviderProfile[]).splice(PROFILES.indexOf(profile), 1);
}

describe("scratch directory", () => {
  it("lives outside the BB data directory, under XDG state", () => {
    expect(scratchBase({ XDG_STATE_HOME: "/s" })).toBe("/s/bb-account-workers/scratch");
    expect(scratchBase({ XDG_STATE_HOME: "relative" })).toMatch(/\.local\/state\/bb-account-workers\/scratch$/);
  });

  it("hands the profile the real scratch path, tool names, provider and model, then runs check", async () => {
    const seen: string[] = [];
    const undo = withProfile({
      id: "probe",
      providerIds: ["probe-provider"],
      async prepare(ctx) {
        seen.push(`prepare ${ctx.scratchDir} ${ctx.bindingId} ${ctx.toolNames.join(",")} ${ctx.providerId} ${ctx.model}`);
        expect(await readdir(ctx.scratchDir)).toEqual([]);
      },
      async check(ctx) {
        seen.push(`check ${ctx.scratchDir}`);
      },
    });
    try {
      const result = await prepareScratch({ bindingId: "aw_p", profile: "probe", providerId: "probe-provider", model: "m1" });
      const dir = path.join(base(), "aw_p");
      expect(result).toEqual({ path: dir });
      expect(seen).toEqual([`prepare ${dir} aw_p ${TOOL_NAMES.join(",")} probe-provider m1`, `check ${dir}`]);
    } finally {
      undo();
    }
  });

  it("removes the scratch directory when prepare or check throws", async () => {
    for (const stage of ["prepare", "check"] as const) {
      const undo = withProfile({
        id: "failing",
        providerIds: [],
        async prepare() {
          if (stage === "prepare") throw new WorkspaceRefusal("no prepare");
        },
        async check() {
          throw new WorkspaceRefusal("no check");
        },
      });
      try {
        await expect(prepareScratch({ bindingId: "aw_f", profile: "failing", providerId: "x", model: null })).rejects.toThrow(`no ${stage}`);
        expect(await readdir(base())).toEqual([]);
      } finally {
        undo();
      }
    }
  });

  it("turns any hook error into a refusal that names the profile and hook", async () => {
    const undo = withProfile({
      id: "plain",
      providerIds: [],
      async prepare(ctx) {
        if (ctx.bindingId === "aw_p1") throw new Error("disk full");
      },
      async check(ctx) {
        if (ctx.bindingId === "aw_p2") throw new TypeError("bad config");
      },
      async verify() {
        throw new Error("trust entry missing");
      },
    });
    try {
      const prepared = await prepareScratch({ bindingId: "aw_p1", profile: "plain", providerId: "x", model: null }).catch((e: unknown) => e);
      expect(prepared).toBeInstanceOf(WorkspaceRefusal);
      expect((prepared as Error).message).toBe("profile plain prepare failed: disk full");
      const checked = await prepareScratch({ bindingId: "aw_p2", profile: "plain", providerId: "x", model: null }).catch((e: unknown) => e);
      expect(checked).toBeInstanceOf(WorkspaceRefusal);
      expect((checked as Error).message).toBe("profile plain check failed: bad config");
      await prepareScratch({ bindingId: "aw_p3", profile: "plain", providerId: "x", model: null });
      const verified = await verifyProfile({ bindingId: "aw_p3", profile: "plain", toolName: "workspace_read", input: {} }).catch((e: unknown) => e);
      expect(verified).toBeInstanceOf(WorkspaceRefusal);
      expect((verified as Error).message).toBe("profile plain verify failed: trust entry missing");
    } finally {
      undo();
    }
  });

  it("refuses an unknown profile before touching the disk", async () => {
    await expect(prepareScratch({ bindingId: "aw_u", profile: "nope", providerId: "x", model: null })).rejects.toThrow("unknown provider profile nope");
    await expect(readdir(base())).rejects.toThrow();
  });

  it("verify runs the profile's hook with the real scratch path; profiles without one accept", async () => {
    const calls: unknown[] = [];
    const undo = withProfile({
      id: "verifying",
      providerIds: [],
      async prepare() {},
      async verify(ctx) {
        calls.push(ctx);
        if (ctx.toolName === "workspace_exec") throw new WorkspaceRefusal("no heartbeat");
      },
    });
    try {
      await prepareScratch({ bindingId: "aw_v", profile: "verifying", providerId: "x", model: null });
      await expect(verifyProfile({ bindingId: "aw_v", profile: "verifying", toolName: "workspace_read", input: { path: "a" } })).resolves.toEqual({});
      await expect(verifyProfile({ bindingId: "aw_v", profile: "verifying", toolName: "workspace_exec", input: {} })).rejects.toThrow("no heartbeat");
      expect(calls[0]).toMatchObject({ scratchDir: path.join(base(), "aw_v"), bindingId: "aw_v", toolName: "workspace_read", input: { path: "a" } });
      await expect(verifyProfile({ bindingId: "aw_none", profile: "claude", toolName: "workspace_read", input: {} })).resolves.toEqual({});
    } finally {
      undo();
    }
  });
});

describe("release", () => {
  const ID = "aw_0123456789abcdef";

  it("runs the profile release with the stored path, then removes the scratch entry", async () => {
    const seen: string[] = [];
    const undo = withProfile({
      id: "probe",
      providerIds: ["probe-provider"],
      async prepare() {},
      async release(ctx) {
        seen.push(`release ${ctx.scratchDir} ${ctx.bindingId}`);
        expect((await stat(path.join(base(), ID))).isDirectory()).toBe(true);
      },
    });
    try {
      await prepareScratch({ bindingId: ID, profile: "probe", providerId: "probe-provider", model: null });
      await writeFile(path.join(base(), ID, "file"), "x");
      expect(await releaseScratch({ bindingId: ID, profile: "probe", scratchPath: "/stored/path" })).toEqual({});
      expect(seen).toEqual([`release /stored/path ${ID}`]);
      expect(await readdir(base())).toEqual([]);
    } finally {
      undo();
    }
  });

  it("is a no-op for a scratch entry that is already gone", async () => {
    await expect(releaseScratch({ bindingId: ID, profile: "claude", scratchPath: "/gone" })).resolves.toEqual({});
  });

  it("refuses an id the server would not mint, before touching anything", async () => {
    await mkdir(path.join(base(), "keep"), { recursive: true });
    for (const bindingId of ["keep", "aw_x", "../aw_0123456789abcdef", "aw_0123456789ABCDEF"]) {
      await expect(releaseScratch({ bindingId, profile: "claude", scratchPath: "/s" })).rejects.toThrow(WorkspaceRefusal);
    }
    expect(await readdir(base())).toEqual(["keep"]);
  });

  it("a symlinked entry loses only the link", async () => {
    const outside = path.join(state, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "precious"), "x");
    await mkdir(base(), { recursive: true });
    await symlink(outside, path.join(base(), ID));
    await releaseScratch({ bindingId: ID, profile: "claude", scratchPath: path.join(base(), ID) });
    expect(await readdir(base())).toEqual([]);
    expect(await readdir(outside)).toEqual(["precious"]);
  });

  it("keeps the scratch entry and reports a refusal when the profile release fails", async () => {
    const undo = withProfile({
      id: "probe",
      providerIds: ["probe-provider"],
      async prepare() {},
      async release() {
        throw new Error("config locked");
      },
    });
    try {
      await prepareScratch({ bindingId: ID, profile: "probe", providerId: "probe-provider", model: null });
      await expect(releaseScratch({ bindingId: ID, profile: "probe", scratchPath: "/s" })).rejects.toThrow("profile probe release failed: config locked");
      expect(await readdir(base())).toEqual([ID]);
    } finally {
      undo();
    }
  });
});
