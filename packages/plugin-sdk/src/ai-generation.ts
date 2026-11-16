export const experimental_AI_MODEL_ID_MAX_LENGTH = 12288;

export interface experimental_AiTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface experimental_AiModel {
  id: string;
  displayName: string;
  provider: string;
  hostId: string;
  profile: string;
  capabilities: {
    maxOutputTokens: boolean;
    temperature: boolean;
    reasoningEfforts: readonly string[];
    /** Omitted by older adapters when no explicit tier is supported. */
    serviceTiers?: readonly string[];
  };
}

export interface experimental_AiGenerationRequest {
  model: string;
  messages: readonly experimental_AiTextMessage[];
  maxOutputTokens: number | null;
  temperature: number | null;
  reasoningEffort: string | null;
  /** Omitted or null selects the provider default. */
  serviceTier?: string | null;
  timeoutMs: number;
}

export interface experimental_AiGenerationResult {
  text: string;
  model: string;
  /** Provider-reported identity, which may resolve an alias; null when not reported. */
  actualModel: string | null;
  /** Actual provider wire tier; omitted or null when not reported. */
  actualServiceTier?: string | null;
  finishReason: "stop" | "length";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
  } | null;
}

export interface experimental_AiTextService {
  models(options: {
    signal: AbortSignal;
  }): Promise<readonly experimental_AiModel[]>;
  generate(
    request: experimental_AiGenerationRequest & { serviceTier: string | null },
    options: {
      signal: AbortSignal;
      model: experimental_AiModel & {
        capabilities: experimental_AiModel["capabilities"] & {
          serviceTiers: readonly string[];
        };
      };
    },
  ): Promise<experimental_AiGenerationResult>;
}

export type experimental_AiGenerationErrorCode =
  | "invalid_request"
  | "unsupported"
  | "unavailable"
  | "busy"
  | "cancelled"
  | "timeout"
  | "failed";

export class experimental_AiGenerationError extends Error {
  constructor(
    readonly code: experimental_AiGenerationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiGenerationError";
  }
}
