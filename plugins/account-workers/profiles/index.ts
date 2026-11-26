import { claudeProfile } from "./claude.js";
import { openCodeProfile } from "./opencode.js";
import type { ProviderProfile } from "./types.js";

export const PROFILES: readonly ProviderProfile[] = [claudeProfile, openCodeProfile];

export function profileById(id: string): ProviderProfile | undefined {
  return PROFILES.find((profile) => profile.id === id);
}

export function profileForProvider(providerId: string): ProviderProfile | undefined {
  return PROFILES.find((profile) => profile.providerIds.includes(providerId));
}

export const DEFAULT_PROVIDER = "claude-code";
