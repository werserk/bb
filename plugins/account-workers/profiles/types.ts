export interface ProfileContext {
  scratchDir: string;
  bindingId: string;
  toolNames: readonly string[];
  providerId: string;
  model: string | null;
  signal: AbortSignal;
}

export interface VerifyContext {
  scratchDir: string;
  bindingId: string;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ReleaseContext {
  scratchDir: string;
  bindingId: string;
  signal: AbortSignal;
}

export interface ProviderProfile {
  id: string;
  providerIds: readonly string[];
  refusedMachineEnv?: readonly string[];
  prepare(ctx: ProfileContext): Promise<void>;
  check?(ctx: ProfileContext): Promise<void>;
  verify?(ctx: VerifyContext): Promise<void>;
  release?(ctx: ReleaseContext): Promise<void>;
}

export const PROFILE_ID = /^[a-z0-9-]{1,32}$/;
