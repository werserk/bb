type Handle = (request: Request) => Promise<Response>;

interface SseEvent {
  type?: string;
  response?: unknown;
}

export async function collectFinalResponse(
  body: ReadableStream<Uint8Array>,
): Promise<{ response: unknown } | { failure: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const scan = (block: string): ReturnType<typeof collectFinalResponse> | null => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "" || data === "[DONE]") return null;
    let event: SseEvent;
    try {
      event = JSON.parse(data) as SseEvent;
    } catch {
      return null;
    }
    if (event.type === "response.completed" || event.type === "response.incomplete")
      return Promise.resolve({ response: event.response });
    if (event.type === "response.failed" || event.type === "error")
      return Promise.resolve({ failure: event });
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/gu, "\n");
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const result = scan(buffer.slice(0, split));
        if (result !== null) return result;
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const tail = scan(buffer);
    if (tail !== null) return tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { failure: { type: "error", message: "stream ended without response.completed" } };
}

export async function handleResponses(
  request: Request,
  handle: Handle,
): Promise<Response> {
  const text = await request.text();
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {}
  const isResponsesRequest =
    payload !== null &&
    typeof payload.model === "string" &&
    "input" in payload;
  if (payload === null || !isResponsesRequest || payload.stream === true)
    return handle(new Request(request, { body: text }));

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const upstream = await handle(
    new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({ ...payload, stream: true }),
      signal: request.signal,
    }),
  );
  if (
    !upstream.ok ||
    upstream.body === null ||
    !(upstream.headers.get("content-type") ?? "").includes("text/event-stream")
  )
    return upstream;
  const result = await collectFinalResponse(upstream.body);
  if ("response" in result) return Response.json(result.response);
  return Response.json({ error: result.failure }, { status: 502 });
}
