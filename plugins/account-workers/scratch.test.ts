import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRefusal } from "./confine.js";
import { PROFILES } from "./profiles/index.js";
import type { ProviderProfile } from "./profiles/types.js";
import { prepareScratch, scratchBase, verifyProfile } from "./scratch.js";
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
