import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { experimental_AiGenerationErrorCode } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { openCodeGoGenerationSchema, type OpenCodeGoGenerationRequest, type OpenRouterModel } from "./contract.js";
import { completionResult, readJson } from "./runtime.js";

// OpenCode Go: the subscription behind the OpenCode Console sign-in, OpenAI chat completions shape.
const BASE_URL = "https://opencode.ai/inference/go/v1";
const CATALOG_TTL_MS = 60000;
// Cloudflare in front of the endpoint rejects requests without a client user agent.
const USER_AGENT = "bb-provider-acp (opencode-go)";
const credentialSchema = z.array(z.object({ integrationID: z.string(), active: z.boolean(), value: z.unknown() }));
const oauthSchema = z.object({ type: z.literal("oauth"), access: z.string().trim().min(1), expires: z.number() });
const catalogSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(12288) })) });

class OpenCodeGoError extends Error {
  constructor(readonly code: experimental_AiGenerationErrorCode, message: string) {
    super(message);
    this.name = "OpenCodeGoError";
  }
}

const failure = () => new OpenCodeGoError("failed", "OpenCode Go request failed");

export function parseOpenCodeGoToken(value: unknown, now = Date.now()): string {
  const result = credentialSchema.safeParse(value);
  if (!result.success) throw failure();
  const active = result.data.filter((item) => item.active && item.integrationID === "opencode");
  if (active.length !== 1) throw failure();
  const oauth = oauthSchema.safeParse(active[0]?.value);
  if (!oauth.success) throw failure();
  if (oauth.data.expires <= now) throw new OpenCodeGoError("unavailable", "OpenCode sign-in expired; open opencode to refresh it");
  return oauth.data.access;
}

function exportOpenCodeGoToken(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("opencode", ["auth", "export", "opencode"], {
      encoding: "utf8", signal, timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) { reject(failure()); return; }
      try { resolve(parseOpenCodeGoToken(JSON.parse(stdout))); }
      catch (cause) { reject(cause instanceof OpenCodeGoError ? cause : failure()); }
    });
  });
}

export function openCodeGoBody(request: OpenCodeGoGenerationRequest) {
  if (request.serviceTier !== null) throw new OpenCodeGoError("unsupported", "OpenCode Go has no service tiers");
  return {
    model: request.model,
    messages: request.messages,
    stream: false,
    ...(request.maxOutputTokens === null ? {} : { max_tokens: request.maxOutputTokens }),
    ...(request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.reasoningEffort === null ? {} : { reasoning_effort: request.reasoningEffort }),
  };
}

const statusCode = (status: number): experimental_AiGenerationErrorCode =>
  status === 401 || status === 403 || status === 429 ? "unavailable" : "failed";

export function createOpenCodeGoRuntime(dependencies: {
  key?: (signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const key = dependencies.key ?? exportOpenCodeGoToken;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let cached: { expires: number; models: OpenRouterModel[] } | null = null;

  async function bounded<T>(signal: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      combined.throwIfAborted();
      const result = await run(combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw new OpenCodeGoError("cancelled", "OpenCode Go request cancelled");
      if (controller.signal.aborted) throw new OpenCodeGoError("timeout", "OpenCode Go request timed out");
      if (error instanceof OpenCodeGoError) throw error;
      throw failure();
    } finally { clearTimeout(timer); }
  }

  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT });

  async function catalog(token: string, signal: AbortSignal): Promise<OpenRouterModel[]> {
    if (cached && cached.expires > now()) return cached.models;
    cached = null;
    const response = await fetcher(`${BASE_URL}/models`, { signal, redirect: "error", headers: headers(token) });
    if (!response.ok) { await response.body?.cancel(); throw new OpenCodeGoError(statusCode(response.status), `OpenCode Go models HTTP ${response.status}`); }
    const parsed = catalogSchema.safeParse(await readJson(response, 1024 * 1024, signal));
    if (!parsed.success) throw failure();
    const models = parsed.data.data.map((model) => ({
      id: model.id, displayName: model.id, maxOutputTokens: true, temperature: true, reasoningEfforts: [],
    }));
    cached = { models, expires: now() + CATALOG_TTL_MS };
    return models;
  }

  return {
    models: (signal: AbortSignal) => bounded(signal, 15000, async (boundedSignal) =>
      catalog(await key(boundedSignal), boundedSignal)),
    generate: (input: OpenCodeGoGenerationRequest, signal: AbortSignal) => bounded(signal, input.timeoutMs, async (boundedSignal) => {
      const parsed = openCodeGoGenerationSchema.safeParse(input);
      if (!parsed.success) throw new OpenCodeGoError("invalid_request", "Invalid OpenCode Go generation request");
      const body = openCodeGoBody(parsed.data);
      const token = await key(boundedSignal);
      const response = await fetcher(`${BASE_URL}/chat/completions`, {
        method: "POST", redirect: "error", signal: boundedSignal,
        headers: {
          ...headers(token),
          "Content-Type": "application/json",
          // Go routes by session; a request without one is rejected.
          "x-opencode-session": parsed.data.experimental_sessionAffinity ?? randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenCodeGoError(statusCode(response.status), `OpenCode Go HTTP ${response.status}`);
      }
      return completionResult(await readJson(response, 1024 * 1024, boundedSignal), parsed.data.model);
    }),
  };
}
