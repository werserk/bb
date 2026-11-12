import { Command } from "commander";
import { QUESTION_CARD_LIMITS } from "@bb/domain";
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

it.each([QUESTION_CARD_LIMITS.body + 1, 65537])(
  "rejects body length %i before any outgoing request with one policy error",
  async (length) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "bb-question-size-"));
    const file = join(root, "card.json");
    await writeFile(
      file,
      JSON.stringify({
        body: "x".repeat(length),
        questions: [
          {
            id: "q",
            prompt: "p".repeat(QUESTION_CARD_LIMITS.prompt + 1),
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      }),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected request"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });
    try {
      const command = new Command();
      registerQuestionCommands(command, () => "http://test");
      await expect(
        command.parseAsync([
          "node",
          "bb",
          "questions",
          "publish",
          "thr_23456789ab",
          "--file",
          file,
          "--turn-id",
          "t",
          "--provider-thread-id",
          "p",
          "--call-id",
          "c",
        ]),
      ).rejects.toThrow("process.exit:1");
      expect(fetch).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledExactlyOnceWith(
        `Error: Question card body: ${length}/${QUESTION_CARD_LIMITS.body} code points. Shorten the question and put the full report in materials.`,
      );
    } finally {
      fetch.mockRestore();
      error.mockRestore();
      exit.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([QUESTION_CARD_LIMITS.total, QUESTION_CARD_LIMITS.total + 1])(
  "checks combined CLI total %i before request",
  async (total) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "bb-question-total-"));
    const file = join(root, "card.json");
    await writeFile(
      file,
      JSON.stringify({
        body: "b".repeat(QUESTION_CARD_LIMITS.body),
        questions: ["a", "b"].map((id) => ({
          id,
          prompt: "p".repeat(QUESTION_CARD_LIMITS.prompt),
          multiSelect: false,
          allowFreeText: true,
        })),
        materials: Array.from({ length: 5 }, (_, i) => ({
          path: `report${i}.md`,
          label: "m".repeat(
            (QUESTION_CARD_LIMITS.total -
              QUESTION_CARD_LIMITS.body -
              2 * QUESTION_CARD_LIMITS.prompt) /
              5 +
              (i === 0 ? total - QUESTION_CARD_LIMITS.total : 0),
          ),
        })),
      }),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "qst_23456789ab" }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit:1");
    });
    try {
      const command = new Command();
      registerQuestionCommands(command, () => "http://test");
      const run = command.parseAsync([
        "node",
        "bb",
        "questions",
        "publish",
        "thr_23456789ab",
        "--file",
        file,
        "--turn-id",
        "t",
        "--provider-thread-id",
        "p",
        "--call-id",
        "c",
      ]);
      if (total === QUESTION_CARD_LIMITS.total) {
        await run;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
      } else {
        await expect(run).rejects.toThrow("process.exit:1");
        expect(fetch).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith(
          `Error: Question card total: ${total}/${QUESTION_CARD_LIMITS.total} code points. Shorten the question and put the full report in materials.`,
        );
      }
    } finally {
      fetch.mockRestore();
      output.mockRestore();
      error.mockRestore();
      exit.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("requests open pages and prints total and cursor instead of a capped history array", async () => {
  const page = {
    questions: [],
    total: 201,
    nextCursor: "next",
    readRevision: "revision",
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json(page));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const program = new Command().exitOverride();
    registerQuestionCommands(program, () => "http://test");
    await program.parseAsync([
      "node",
      "bb",
      "questions",
      "list",
      "thr_23456789ab",
      "--open",
      "--limit",
      "40",
      "--cursor",
      "older",
      "--json",
    ]);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/threads/thr_23456789ab/questions/open");
    expect(url.searchParams.get("limit")).toBe("40");
    expect(url.searchParams.get("cursor")).toBe("older");
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(page);
  } finally {
    fetch.mockRestore();
    output.mockRestore();
  }
});

it("sends an attributable resolution request unchanged through the shared SDK route", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "bb-cli-resolve-"));
  const input = {
    threadId: "thr_23456789ab",
    questionId: "qst_23456789ab",
    revision: 1,
    operationId: "scope-change",
    action: "withdraw",
    reason: "No longer needed",
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      resolution: {
        actor: { kind: "local-unverified", verification: "unverified-local" },
      },
    }),
  );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const file = join(root, "request.json");
    await writeFile(file, JSON.stringify(input));
    const program = new Command();
    registerQuestionCommands(program, () => "http://test");
    await program.parseAsync([
      "node",
      "bb",
      "questions",
      "resolve",
      "--file",
      file,
      "--json",
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "http://test/api/v1/threads/thr_23456789ab/question-resolution",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(input);
    expect(output.mock.calls[0]?.[0]).toContain("local-unverified");
  } finally {
    fetch.mockRestore();
    output.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
