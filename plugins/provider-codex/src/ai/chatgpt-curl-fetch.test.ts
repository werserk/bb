import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCurlChatGptFetch,
  selectChatGptTranscriptionFetch,
} from "./chatgpt-curl-fetch.js";
import { AiServiceFailure } from "./failure.js";

const URL = "https://chatgpt.com/backend-api/transcribe";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

interface FakeCurl {
  curlPath: string;
  argsPath: string;
  configPath: string;
  bodyPath: string;
}

async function makeFakeCurl(behaviour: string): Promise<FakeCurl> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-fake-curl-"));
  tempDirs.push(dir);
  const fake: FakeCurl = {
    curlPath: path.join(dir, "curl"),
    argsPath: path.join(dir, "args"),
    configPath: path.join(dir, "config"),
    bodyPath: path.join(dir, "body"),
  };
  await fs.writeFile(
    fake.curlPath,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$@" > '${fake.argsPath}'`,
      `cat > '${fake.configPath}'`,
      `staged=$(sed -n 's/^data-binary = "@\\(.*\\)"$/\\1/p' '${fake.configPath}')`,
      `cp "$staged" '${fake.bodyPath}'`,
      behaviour,
    ].join("\n"),
    { mode: 0o700 },
  );
  return fake;
}

function transcriptionInit(signal: AbortSignal): RequestInit & {
  signal: AbortSignal;
} {
  const formData = new FormData();
  formData.set("file", new Blob([Buffer.from("audio-bytes")]), "prompt.webm");
  formData.set("model", "gpt-4o-mini-transcribe");
  return {
    method: "POST",
    headers: new Headers({
      Authorization: "Bearer secret-token",
      "chatgpt-account-id": "account-123",
    }),
    body: formData,
    signal,
  };
}

async function failureOf(promise: Promise<Response>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("Expected the transport to fail");
}

describe.skipIf(process.platform === "win32")("curl ChatGPT transport", () => {
  it("sends the request through curl with secrets on stdin only", async () => {
    const fake = await makeFakeCurl(
      'printf \'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"text":"hello"}\'',
    );

    const response = await createCurlChatGptFetch({ curlPath: fake.curlPath })(
      URL,
      transcriptionInit(new AbortController().signal),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ text: "hello" });
    expect(await fs.readFile(fake.argsPath, "utf8")).toBe("-q\n--config\n-\n");
    const config = await fs.readFile(fake.configPath, "utf8");
    expect(config).toContain(`url = "${URL}"`);
    expect(config).toContain('request = "POST"');
    expect(config).toContain('header = "authorization: Bearer secret-token"');
    expect(config).toContain('header = "chatgpt-account-id: account-123"');
    expect(config).toMatch(/header = "content-type: multipart\/form-data;/u);
    expect(config).toContain('proto = "=https"');
    const body = await fs.readFile(fake.bodyPath, "utf8");
    expect(body).toContain("audio-bytes");
    expect(body).toContain('name="model"');
    expect(body).toContain("gpt-4o-mini-transcribe");
    expect(body).toContain('filename="prompt.webm"');
  });

  it("removes the staged audio after the request", async () => {
    const fake = await makeFakeCurl(
      'printf \'HTTP/1.1 200 OK\\r\\n\\r\\n{"text":""}\'',
    );

    await createCurlChatGptFetch({ curlPath: fake.curlPath })(
      URL,
      transcriptionInit(new AbortController().signal),
    );

    const config = await fs.readFile(fake.configPath, "utf8");
    const staged = /^data-binary = "@(.*)"$/mu.exec(config)?.[1];
    expect(staged).toContain("bb-voice-curl-");
    await expect(fs.stat(path.dirname(staged ?? ""))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns non-2xx responses with their status, headers and body", async () => {
    const fake = await makeFakeCurl(
      'printf \'HTTP/1.1 429 Too Many Requests\\r\\nRetry-After: 7\\r\\nSet-Cookie: __cf_bm=abc; Path=/\\r\\n\\r\\n{"error":"slow down"}\'',
    );

    const response = await createCurlChatGptFetch({ curlPath: fake.curlPath })(
      URL,
      transcriptionInit(new AbortController().signal),
    );

    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("set-cookie")).toBe("__cf_bm=abc; Path=/");
    expect(await response.text()).toBe('{"error":"slow down"}');
  });

  it("skips interim 1xx responses", async () => {
    const fake = await makeFakeCurl(
      "printf 'HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/1.1 200 OK\\r\\nX-Real: yes\\r\\n\\r\\nok'",
    );

    const response = await createCurlChatGptFetch({ curlPath: fake.curlPath })(
      URL,
      transcriptionInit(new AbortController().signal),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-real")).toBe("yes");
    expect(await response.text()).toBe("ok");
  });

  it("reports a missing curl with its path", async () => {
    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: "/nonexistent/curl" })(
        URL,
        transcriptionInit(new AbortController().signal),
      ),
    );

    expect(error).toBeInstanceOf(AiServiceFailure);
    expect(error).toMatchObject({
      code: "request_failed",
      detailCode: "codex_transcription_curl_missing",
    });
    expect(error.message).toBe(
      "Codex voice needs curl at /nonexistent/curl, which was not found.",
    );
  });

  it("reports a failing curl without leaking its diagnostics", async () => {
    const fake = await makeFakeCurl(
      "echo 'Bearer secret-token leaked' >&2\nexit 7",
    );

    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(
        URL,
        transcriptionInit(new AbortController().signal),
      ),
    );

    expect(error).toMatchObject({
      code: "request_failed",
      detailCode: "codex_transcription_curl_failed",
    });
    expect(error.message).toContain("curl exited with code 7");
    expect(error.message).not.toContain("secret-token");
  });

  it("rejects output that is not an HTTP response", async () => {
    const fake = await makeFakeCurl("printf 'not http'");

    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(
        URL,
        transcriptionInit(new AbortController().signal),
      ),
    );

    expect(error).toMatchObject({
      detailCode: "codex_transcription_curl_invalid_response",
    });
  });

  it("rejects responses beyond the memory guard", async () => {
    const fake = await makeFakeCurl(
      "printf 'HTTP/1.1 200 OK\\r\\n\\r\\n'\nhead -c 3000000 /dev/zero",
    );

    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(
        URL,
        transcriptionInit(new AbortController().signal),
      ),
    );

    expect(error).toMatchObject({
      code: "invalid_response",
      detailCode: "codex_response_too_large",
    });
  });

  it("kills curl and rejects when the request is aborted", async () => {
    const fake = await makeFakeCurl("exec sleep 30");
    const abortController = new AbortController();
    const reason = new Error("deadline passed");

    const pending = failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(
        URL,
        transcriptionInit(abortController.signal),
      ),
    );
    await fs.stat(fake.curlPath);
    setTimeout(() => abortController.abort(reason), 300);

    expect(await pending).toBe(reason);
  });

  it("does not start curl when the request is already aborted", async () => {
    const fake = await makeFakeCurl("exit 0");
    const abortController = new AbortController();
    abortController.abort(new Error("cancelled"));

    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(
        URL,
        transcriptionInit(abortController.signal),
      ),
    );

    expect(error.message).toBe("cancelled");
    await expect(fs.stat(fake.argsPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a request it cannot serialize", async () => {
    const fake = await makeFakeCurl("exit 0");
    const init = transcriptionInit(new AbortController().signal);
    init.headers = { "bad-header": "line\nbreak" };

    const error = await failureOf(
      createCurlChatGptFetch({ curlPath: fake.curlPath })(URL, init),
    );

    expect(error).toMatchObject({
      detailCode: "codex_transcription_transport_invalid_request",
    });
  });

  it("is the selected transcription transport on Linux", () => {
    const selected = selectChatGptTranscriptionFetch();

    expect(selected === fetch).toBe(process.platform !== "linux");
  });
});
