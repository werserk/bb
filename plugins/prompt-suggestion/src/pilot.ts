import { z } from "zod";
import { composeInstructionBundle } from "./instruction-bundle.js";
import { contextInput, sourceMessage, textRevision } from "./context-input.js";
import {
  taskStateSchema,
  emptyTaskState,
  rememberTask,
  validateStateSources,
} from "./task-state.js";
import { resultSchema } from "./generate.js";

export const fixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z-]+$/),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    seedIndex: z.number().int().nonnegative().nullable(),
    hasOlder: z.boolean(),
    expected: z
      .object({
        kinds: z.array(z.enum(["suggestion", "none"])).min(1),
        direction: z.string().min(1),
        any: z.array(z.string()),
        forbidden: z.array(z.string()),
        evidenceMustBeEmpty: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (
      fixture.seedIndex !== null &&
      fixture.messages[fixture.seedIndex]?.role !== "user"
    )
      context.addIssue({
        code: "custom",
        message: "Seed must reference an actual user message",
      });
    for (const pattern of [
      ...fixture.expected.any,
      ...fixture.expected.forbidden,
    ]) {
      try {
        new RegExp(pattern, "iu");
      } catch {
        context.addIssue({
          code: "custom",
          message: "Invalid assertion pattern",
        });
      }
    }
  });
export const fixturesSchema = z
  .array(fixtureSchema)
  .min(1)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Duplicate fixture IDs",
  );
export type PilotFixture = z.infer<typeof fixtureSchema>;
export type PilotOptions = ReturnType<typeof parsePilotArgs>;

export function parsePilotArgs(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "instructions-file",
    "model",
    "origin",
    "max-calls",
    "max-output-tokens",
    "output",
    "cases",
    "reasoning-effort",
    "session-affinity",
    "service-tier",
    "role",
  ]);
  let live = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--live" && !live) {
      live = true;
      continue;
    }
    const key = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(key) || values.has(key))
      throw new Error("Unknown or duplicate option");
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error("Missing option value");
    values.set(key, value);
  }
  const positive = (
    key: string,
    fallback: number,
    maximum: number,
    minimum: number,
  ) => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    if (
      !/^\d+$/.test(value) ||
      Number(value) < minimum ||
      Number(value) > maximum
    )
      throw new Error(`Invalid --${key}`);
    return Number(value);
  };
  const instructionsFile = values.get("instructions-file");
  const model = values.get("model");
  if (!instructionsFile || !model || model.split("/").length < 5)
    throw new Error(
      "Explicit --instructions-file and native qualified --model are required",
    );
  const origin = values.get("origin") ?? null;
  if (origin !== null) {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Origin must be a local BB API origin");
  }
  const maxCalls = positive("max-calls", 0, 20, 1);
  const maxOutputTokens = positive("max-output-tokens", 0, 2048, 0);
  const output = values.get("output") ?? null;
  if (
    live &&
    (!origin ||
      !output ||
      !values.has("max-calls") ||
      !values.has("max-output-tokens"))
  )
    throw new Error(
      "Live mode requires --origin, --output and explicit call/output limits",
    );
  const reasoningEffort = values.get("reasoning-effort") ?? "none";
  if (!["none", "low"].includes(reasoningEffort))
    throw new Error("Pilot effort must be none or low");
  const serviceTier = values.get("service-tier") ?? "default";
  if (!["default", "fast"].includes(serviceTier))
    throw new Error("Unsupported service tier");
  const sessionAffinity = values.get("session-affinity") ?? null;
  if (
    sessionAffinity !== null &&
    !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionAffinity)
  )
    throw new Error("Affinity must be an opaque identifier");
  const role = z.enum(["suggestion", "memory"]).parse(values.get("role") ?? "suggestion");
  return {
    role,
    live,
    origin,
    output,
    instructionsFile,
    model,
    maxCalls,
    maxOutputTokens,
    reasoningEffort,
    serviceTier,
    sessionAffinity,
    cases: values.get("cases")?.split(",") ?? null,
  };
}

export function preparePilotCase(fixture: PilotFixture, ownerContent: string, role: "suggestion" | "memory" = "suggestion") {
  const bundle = composeInstructionBundle(
    { content: ownerContent, revision: textRevision(ownerContent) },
    "",
    role,
  );
  const messages = fixture.messages.map((message, index) =>
    sourceMessage(`${fixture.id}-${index}`, message.role, message.text, index),
  );
  const seed = fixture.seedIndex === null ? null : messages[fixture.seedIndex];
  const state = emptyTaskState();
  state.contextComplete = !fixture.hasOlder;
  if (seed)
    state.goal = {
      text: seed.text,
      sources: [{ messageId: seed.messageId, revision: seed.revision }],
    };
  const memory = seed ? rememberTask(state, messages, null) : null;
  const context = contextInput(messages, 20000, memory, null, fixture.hasOlder);
  if (!context) throw new Error("Fixture context does not fit");
  return { bundle, context };
}

const completionSchema = z.object({
  model: z.string(),
  service_tier: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string(),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      total_tokens: z.number().nonnegative(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().nonnegative() })
        .optional(),
    })
    .optional(),
});

function redactPrivateStrings(ownerContent: string, token: string) {
  const secrets = [
    ...new Set(
      [ownerContent, token, ...ownerContent.split(/\r?\n/)]
        .flatMap((value) => [value, value.trim()])
        .filter((value) => value.length > 0),
    ),
  ].sort((a, b) => b.length - a.length);
  const text = (value: string) => {
    let current = value;
    for (;;) {
      const next = secrets.reduce(
        (result, secret) => result.split(secret).join(""),
        current,
      );
      if (next === current) return next;
      current = next;
    }
  };
  const decoded = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (Array.isArray(value)) return value.map(decoded);
    if (typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, decoded(item)]),
      );
    throw new Error("Invalid artifact value");
  };
  return { text, decoded };
}

function evaluateCompletion(
  payload: unknown,
  fixture: PilotFixture,
  context: NonNullable<ReturnType<typeof contextInput>>,
  ownerContent: string,
  token: string,
  latencyMs: number,
  role: "suggestion" | "memory",
) {
  const envelope = completionSchema.safeParse(payload);
  if (!envelope.success) {
    return {
      id: fixture.id,
      latencyMs,
      validation: "envelope-schema-error",
    };
  }
  const result = envelope.data;
  const choice = result.choices[0]!;
  const raw = choice.message.content;
  const redact = redactPrivateStrings(ownerContent, token);
  const measured = {
    id: fixture.id,
    contextBytes: Buffer.byteLength(context.text),
    latencyMs,
    actualModel: redact.text(result.model),
    actualServiceTier:
      result.service_tier === undefined
        ? null
        : redact.text(result.service_tier),
    usage: result.usage ?? null,
    finishReason: redact.text(choice.finish_reason),
  };
  if (choice.finish_reason !== "stop" || Buffer.byteLength(raw) > 65536) {
    return { ...measured, validation: "incomplete-or-oversized" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...measured, validation: "result-json-error" };
  }
  const parsed = role === "memory" ? taskStateSchema.safeParse(value) : resultSchema.safeParse(value);
  if (!parsed.success) return { ...measured, validation: "result-schema-error" };
  const output = parsed.data;
  let assertions: Record<string, boolean>;
  if ("kind" in output) {
    const text = output.kind === "suggestion" ? output.text : "";
    assertions = {
      kind: fixture.expected.kinds.includes(output.kind),
      direction: !fixture.expected.any.length || fixture.expected.any.some((pattern) => new RegExp(pattern, "iu").test(text)),
      forbidden: fixture.expected.forbidden.every((pattern) => !new RegExp(pattern, "iu").test(text)),
    };
  } else {
    try { validateStateSources(output, context.messages); }
    catch { return { ...measured, validation: "source-validation-error" }; }
    assertions = {
      evidence: !fixture.expected.evidenceMustBeEmpty || output.visibleEvidence.length === 0,
      context: context.contextComplete || !output.contextComplete,
    };
  }
  const rawSyntheticResult = JSON.stringify(redact.decoded(parsed.data));
  return {
    ...measured,
    validation: "valid",
    rawSyntheticResult,
    redactionApplied: rawSyntheticResult !== JSON.stringify(parsed.data),
    resultRepresentation: "validated-and-redacted-json",
    assertions,
    screeningPassed: Object.values(assertions).every(Boolean),
  };
}

async function connectGateway(options: PilotOptions, transport: typeof fetch) {
  const request = async (path: string, init: RequestInit) =>
    transport(`${options.origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30000),
    });
  const tokenResponse = await request("/api/v1/plugins/ai-gateway/token", {
    method: "POST",
  });
  if (!tokenResponse.ok)
    throw new Error(`Token request failed (${tokenResponse.status})`);
  const token = z
    .object({ token: z.string().min(1) })
    .parse(await tokenResponse.json()).token;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const base = "/api/v1/plugins/ai-gateway/http/v1";
  const catalogResponse = await request(`${base}/models`, { headers });
  if (!catalogResponse.ok)
    throw new Error(`Catalog failed (${catalogResponse.status})`);
  const catalog = z
    .object({
      data: z.array(z.object({ id: z.string(), owned_by: z.string() })),
    })
    .parse(await catalogResponse.json());
  const model = catalog.data.find((item) => item.id === options.model);
  if (!model) throw new Error("Requested model is absent from native catalog");
  if (
    options.maxOutputTokens === 0 &&
    !(
      model.owned_by.includes("codex") &&
      decodeURIComponent(model.id).includes("terra")
    )
  )
    throw new Error(
      "Zero output budget is only allowed for the explicitly selected subscription Terra baseline",
    );
  return { request, headers, base, token };
}

export async function runPilot(
  options: PilotOptions,
  fixtures: PilotFixture[],
  ownerContent: string,
  transport: typeof fetch = fetch,
) {
  if (!ownerContent.trim()) throw new Error("Instructions file is empty");
  const selected = options.cases
    ? options.cases.map((id) => {
        const fixture = fixtures.find((item) => item.id === id);
        if (!fixture) throw new Error("Unknown case");
        return fixture;
      })
    : fixtures;
  if (new Set(selected.map((item) => item.id)).size !== selected.length)
    throw new Error("Repeated cases are not allowed");
  const prepared = selected.map((fixture) => ({
    fixture,
    ...preparePilotCase(fixture, ownerContent, options.role),
  }));
  const bundle = prepared[0]?.bundle;
  if (!bundle) throw new Error("No cases selected");
  const metadata = {
    role: options.role,
    mode: options.live ? "live" : "dry-run",
    requestedModel: options.model,
    requestedServiceTier: options.serviceTier,
    reasoningEffort: options.reasoningEffort,
    maxCalls: options.maxCalls,
    maxOutputTokens: options.maxOutputTokens,
    outputCap:
      options.maxOutputTokens === 0
        ? "unsupported; provider limit unknown"
        : "requested",
    ownerRevision: bundle.ownerRevision,
    ownerCharacters: ownerContent.length,
    instructionRevision: bundle.revision,
    instructionCharacters: bundle.content.length,
    semanticReview: "required; regex assertions are screening only",
  };
  const summaries = prepared.map(({ fixture, context }) => ({
    id: fixture.id,
    contextBytes: Buffer.byteLength(context.text),
    expected: fixture.expected,
  }));
  if (!options.live)
    return {
      ...metadata,
      catalogValidation: "not performed (no network)",
      cases: summaries,
      calls: [],
    };
  if (
    !options.origin ||
    !options.output ||
    options.maxCalls < 1 ||
    options.maxCalls > 20 ||
    options.maxOutputTokens < 0 ||
    options.maxOutputTokens > 2048
  )
    throw new Error("Live limits missing or invalid");
  const { request, headers, base, token } = await connectGateway(
    options,
    transport,
  );
  const calls = [];
  for (const { fixture, context } of prepared.slice(0, options.maxCalls)) {
    const start = performance.now();
    const body = JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: bundle.content },
        { role: "user", content: context.text },
      ],
      reasoning_effort: options.reasoningEffort,
      service_tier: options.serviceTier,
      stream: false,
      ...(options.maxOutputTokens
        ? { max_completion_tokens: options.maxOutputTokens }
        : {}),
      ...(options.sessionAffinity
        ? { prompt_cache_key: options.sessionAffinity }
        : {}),
    });
    if (Buffer.byteLength(body) > 262144)
      throw new Error("Input exceeds gateway body limit");
    let response: Response;
    try {
      response = await request(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body,
      });
    } catch {
      calls.push({
        id: fixture.id,
        latencyMs: performance.now() - start,
        validation: "transport-error",
      });
      break;
    }
    if (!response.ok) {
      calls.push({
        id: fixture.id,
        latencyMs: performance.now() - start,
        validation: "http-error",
        status: response.status,
      });
      break;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      calls.push({
        id: fixture.id,
        latencyMs: performance.now() - start,
        validation: "envelope-json-error",
      });
      continue;
    }
    const latencyMs = performance.now() - start;
    calls.push(
      evaluateCompletion(
        payload,
        fixture,
        context,
        ownerContent,
        token,
        latencyMs,
        options.role,
      ),
    );
  }
  return {
    ...metadata,
    catalogValidation: "exact model ID found",
    cases: summaries,
    calls,
    skippedAtCallCap: prepared.length - calls.length,
  };
}
