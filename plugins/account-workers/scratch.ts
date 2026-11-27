import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { WorkspaceRefusal } from "./confine.js";
import { BINDING_ID } from "./ids.js";
import { profileById } from "./profiles/index.js";
import type { ProviderProfile } from "./profiles/types.js";
import { TOOL_NAMES } from "./tools.js";

export function scratchBase(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(homedir(), ".local", "state");
  return path.join(state, "bb-account-workers", "scratch");
}

function asRefusal(profile: ProviderProfile, hook: string, error: unknown): WorkspaceRefusal {
  if (error instanceof WorkspaceRefusal) return error;
  return new WorkspaceRefusal(`profile ${profile.id} ${hook} failed: ${error instanceof Error ? error.message : String(error)}`);
}

async function runHook(profile: ProviderProfile, hook: string, run: () => Promise<void> | undefined): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw asRefusal(profile, hook, error);
  }
}

function knownProfile(id: string): ProviderProfile {
  const profile = profileById(id);
  if (profile === undefined) throw new WorkspaceRefusal(`unknown provider profile ${id}`);
  return profile;
}

export async function prepareScratch(
  input: { bindingId: string; profile: string; providerId: string; model: string | null },
  signal: AbortSignal = new AbortController().signal,
  toolNames: readonly string[] = TOOL_NAMES,
) {
  const profile = knownProfile(input.profile);
  const dir = path.join(scratchBase(), input.bindingId);
  await mkdir(dir, { recursive: true });
  try {
    const scratchDir = await realpath(dir);
    const ctx = { scratchDir, bindingId: input.bindingId, toolNames, providerId: input.providerId, model: input.model, signal };
    await runHook(profile, "prepare", () => profile.prepare(ctx));
    await runHook(profile, "check", () => profile.check?.(ctx));
    return { path: scratchDir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyProfile(
  input: { bindingId: string; profile: string; toolName: string; input: Record<string, unknown> },
  signal: AbortSignal = new AbortController().signal,
) {
  const profile = knownProfile(input.profile);
  const { verify } = profile;
  if (verify === undefined) return {};
  const scratchDir = await realpath(path.join(scratchBase(), input.bindingId));
  await runHook(profile, "verify", () => verify.call(profile, { scratchDir, bindingId: input.bindingId, toolName: input.toolName, input: input.input, signal }));
  return {};
}

export async function releaseScratch(
  input: { bindingId: string; profile: string; scratchPath?: string },
  signal: AbortSignal = new AbortController().signal,
) {
  if (!BINDING_ID.test(input.bindingId)) throw new WorkspaceRefusal(`invalid binding id ${input.bindingId}`);
  const scratchPath = input.scratchPath ?? path.join(scratchBase(), input.bindingId);
  if (path.basename(scratchPath) !== input.bindingId) {
    throw new WorkspaceRefusal(`scratch path does not belong to binding ${input.bindingId}`);
  }
  const profile = knownProfile(input.profile);
  const { release } = profile;
  if (release !== undefined) {
    await runHook(profile, "release", () =>
      release.call(profile, { scratchDir: scratchPath, bindingId: input.bindingId, signal }),
    );
  }
  await rm(path.join(scratchBase(), input.bindingId), { recursive: true, force: true });
  return {};
}
