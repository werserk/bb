import { execFile } from "node:child_process";
import { expect, it, vi } from "vitest";
import { exportOpenCodeKey } from "./runtime.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

it("bounds the exact credential command and discards process errors, stdout and stderr", async () => {
  const signal = new AbortController().signal;
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args.at(-1);
    if (typeof callback === "function") callback(new Error("synthetic-secret"), "synthetic-secret", "synthetic-secret");
    return {} as ReturnType<typeof execFile>;
  });
  await expect(exportOpenCodeKey(signal)).rejects.toThrow("OpenRouter request failed");
  expect(execFile).toHaveBeenCalledWith("opencode", ["auth", "export", "openrouter"], {
    signal, encoding: "utf8", timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL",
  }, expect.any(Function));
});

it("sanitizes malformed exported JSON", async () => {
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args.at(-1);
    if (typeof callback === "function") callback(null, "synthetic-secret", "");
    return {} as ReturnType<typeof execFile>;
  });
  await expect(exportOpenCodeKey(new AbortController().signal)).rejects.toThrow("OpenRouter request failed");
});
