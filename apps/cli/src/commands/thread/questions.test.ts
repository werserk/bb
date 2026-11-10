import { Command } from "commander";
import { it, expect, vi } from "vitest";
import { registerQuestionCommands } from "./questions.js";

it("sends the original question ID and explicit revision through the SDK", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ id: "qst_23456789ab", status: "dismissed" }),
    );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const program = new Command();
    registerQuestionCommands(program, () => "http://test");
    await program.parseAsync([
      "node",
      "bb",
      "questions",
      "dismiss",
      "qst_23456789ab",
      "thr_23456789ab",
      "--revision",
      "1",
      "--json",
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "http://test/api/v1/threads/thr_23456789ab/questions/qst_23456789ab/dismiss",
    );
    expect(fetch.mock.calls[0]![1]?.body).toBe(JSON.stringify({ revision: 1 }));
  } finally {
    fetch.mockRestore();
    output.mockRestore();
  }
});

it("preserves publication materials, source identity and exact answer content from files", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bb-cli-question-"));
  const publication = {
    body: "Listen first",
    questions: [
      {
        id: "voice",
        prompt: "Which voice?",
        multiSelect: false,
        allowFreeText: true,
        required: true,
      },
    ],
    materials: [{ path: "voices/a.mp3", label: "Sample A", dependencies: [] }],
  };
  const answer = {
    revision: 1,
    answers: { voice: { selected: [], freeText: " Keep the original voice " } },
  };
  const file = join(root, "publication.json");
  const answerFile = join(root, "answer.json");
  await writeFile(file, JSON.stringify(publication));
  await writeFile(answerFile, JSON.stringify(answer));
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ id: "qst_23456789ab" }));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const publish = new Command();
    registerQuestionCommands(publish, () => "http://test");
    await publish.parseAsync([
      "node",
      "bb",
      "questions",
      "publish",
      "thr_23456789ab",
      "--file",
      file,
      "--turn-id",
      "original-turn",
      "--provider-thread-id",
      "original-provider",
      "--call-id",
      "original-call",
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      source: {
        turnId: "original-turn",
        providerThreadId: "original-provider",
        callId: "original-call",
      },
      publication,
    });
    const respond = new Command();
    registerQuestionCommands(respond, () => "http://test");
    await respond.parseAsync([
      "node",
      "bb",
      "questions",
      "answer",
      "qst_23456789ab",
      "thr_23456789ab",
      "--file",
      answerFile,
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual(answer);
  } finally {
    fetch.mockRestore();
    output.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
