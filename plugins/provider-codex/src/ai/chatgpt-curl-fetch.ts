import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiServiceFailure } from "./failure.js";

export type ChatGptFetch = (
  url: string,
  init: RequestInit & { signal: AbortSignal },
) => Promise<Response>;

export interface CurlChatGptFetchOptions {
  curlPath?: string;
}

const DEFAULT_CURL_PATH = "/usr/bin/curl";
const CURL_HEADER_MAX_BYTES = 32 * 1024;
const CURL_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

export function selectChatGptTranscriptionFetch(): ChatGptFetch {
  return process.platform === "linux" ? createCurlChatGptFetch() : fetch;
}

export function createCurlChatGptFetch(
  options: CurlChatGptFetchOptions = {},
): ChatGptFetch {
  const curlPath = options.curlPath ?? DEFAULT_CURL_PATH;
  return (url, init) => curlChatGptFetch({ curlPath, url, init });
}

interface CurlFetchArgs {
  curlPath: string;
  url: string;
  init: RequestInit & { signal: AbortSignal };
}

function curlFailure(detailCode: string, message: string): AiServiceFailure {
  return new AiServiceFailure("request_failed", detailCode, message);
}

function quoteCurlConfigValue(value: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw curlFailure(
      "codex_transcription_transport_invalid_header",
      "Codex transcription request has an invalid header.",
    );
  }
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function buildCurlConfig(
  url: string,
  request: Request,
  audioPath: string,
): string {
  return [
    `url = ${quoteCurlConfigValue(url)}`,
    'request = "POST"',
    ...[...request.headers].map(
      ([key, value]) => `header = ${quoteCurlConfigValue(`${key}: ${value}`)}`,
    ),
    `data-binary = ${quoteCurlConfigValue(`@${audioPath}`)}`,
    "include",
    'output = "-"',
    'proto = "=https"',
    "http1.1",
    "silent",
  ].join("\n");
}

function parseCurlOutput(output: Buffer): Response {
  let data = output;
  let headerBytes = 0;
  let status = 0;
  let headers = new Headers();
  let moreHeaders = false;
  do {
    const end = data.indexOf("\r\n\r\n");
    if (end < 0) {
      throw new Error("missing header terminator");
    }
    headerBytes += end + 4;
    if (headerBytes > CURL_HEADER_MAX_BYTES) {
      throw new Error("headers too large");
    }
    const lines = data.subarray(0, end).toString("utf8").split("\r\n");
    const statusLine = lines.shift() ?? "";
    status = Number(/^HTTP\/\S+ (\d{3})\b/u.exec(statusLine)?.[1]);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("invalid status line");
    }
    moreHeaders =
      status < 200 || / 200 Connection established$/iu.test(statusLine);
    headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) {
        throw new Error("invalid header line");
      }
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    data = data.subarray(end + 4);
  } while (moreHeaders);
  const bodyless = [204, 205, 304].includes(status);
  return new Response(bodyless ? null : new Uint8Array(data), {
    status,
    headers,
  });
}

function runCurl(args: {
  curlPath: string;
  config: string;
  signal: AbortSignal;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(args.curlPath, ["-q", "--config", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      args.signal.removeEventListener("abort", abort);
      finish();
    };
    const fail = (error: Error): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    function abort(): void {
      fail(
        args.signal.reason instanceof Error
          ? args.signal.reason
          : new Error("Transcription cancelled"),
      );
    }
    args.signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === "ENOENT"
            ? curlFailure(
                "codex_transcription_curl_missing",
                `Codex voice needs curl at ${args.curlPath}, which was not found.`,
              )
            : curlFailure(
                "codex_transcription_curl_start_failed",
                "Codex transcription transport could not start curl.",
              ),
        ),
      );
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      fail(
        curlFailure(
          "codex_transcription_transport_write_failed",
          "Codex transcription transport write failed.",
        ),
      );
    });
    child.stdout.on("error", () => {
      fail(
        curlFailure(
          "codex_transcription_transport_read_failed",
          "Codex transcription transport read failed.",
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CURL_OUTPUT_MAX_BYTES) {
        fail(
          new AiServiceFailure(
            "invalid_response",
            "codex_response_too_large",
            "Codex response exceeded the maximum supported size.",
          ),
        );
      } else {
        chunks.push(chunk);
      }
    });
    child.on("close", (code) => {
      settle(() => {
        if (failure) {
          reject(failure);
        } else if (code !== 0) {
          reject(
            curlFailure(
              "codex_transcription_curl_failed",
              `Codex transcription request failed: curl exited with code ${code}.`,
            ),
          );
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
    if (args.signal.aborted) {
      abort();
    }
    child.stdin.end(args.config);
  });
}

async function curlChatGptFetch(args: CurlFetchArgs): Promise<Response> {
  const { signal } = args.init;
  signal.throwIfAborted();
  let request: Request;
  try {
    request = new Request(args.url, {
      method: "POST",
      headers: args.init.headers,
      body: args.init.body,
    });
  } catch {
    throw curlFailure(
      "codex_transcription_transport_invalid_request",
      "Codex transcription request could not be built.",
    );
  }
  const body = Buffer.from(await request.arrayBuffer());
  signal.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bb-voice-curl-"));
  try {
    const audioPath = path.join(directory, "audio");
    await fs.writeFile(audioPath, body, { mode: 0o600, flag: "wx" });
    signal.throwIfAborted();
    const output = await runCurl({
      curlPath: args.curlPath,
      config: buildCurlConfig(args.url, request, audioPath),
      signal,
    });
    try {
      return parseCurlOutput(output);
    } catch {
      throw curlFailure(
        "codex_transcription_curl_invalid_response",
        "Codex transcription curl transport returned an invalid response.",
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
