import { z } from "zod";

export const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("suggestion"),
      text: z
        .string()
        .trim()
        .min(1)
        .refine((s) => [...s].length <= 600),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type GenerationResult = z.infer<typeof resultSchema>;
export type GeneratorConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  instructions: string;
  timeoutMs: number;
  outputTokenLimit: number;
};

export function completionUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid generator URL");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url;
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty generator response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) throw new Error("Generator response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const envelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal("stop"),
        message: z.object({
          content: z.string(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
        }),
      }),
    )
    .length(1),
});

export async function generate(
  config: GeneratorConfig,
  context: string,
  signal: AbortSignal,
): Promise<GenerationResult> {
  const response = await fetch(completionUrl(config.baseUrl), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: config.instructions },
        { role: "user", content: context },
      ],
      max_tokens: config.outputTokenLimit,
      stream: false,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Generator HTTP ${response.status}`);
  }
  const envelope = envelopeSchema.parse(
    JSON.parse(await boundedBody(response)),
  );
  return resultSchema.parse(JSON.parse(envelope.choices[0]!.message.content));
}
