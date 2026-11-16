import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fixturesSchema,
  parsePilotArgs,
  preparePilotCase,
  runPilot,
} from "./pilot.js";
import { emptyTaskState } from "./task-state.js";

const fixtures = fixturesSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../fixtures/companion-quality.json", import.meta.url),
      "utf8",
    ),
  ),
);
const model = "codex-provider/text/host/profile/gpt-6.1-terra";
const base = ["--instructions-file", "/owner/AGENTS.md", "--model", model];
const live = () =>
  parsePilotArgs([
    ...base,
    "--live",
    "--origin",
    "http://127.0.0.1:4000",
    "--output",
    "/report.json",
    "--max-calls",
    "2",
    "--max-output-tokens",
    "0",
    "--reasoning-effort",
    "low",
  ]);
const owner = "Owner instructions used only in memory for this fixture test.";
function harness(results: Response[], catalogModel = model) {
  const requests: { path: string; body: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = String(input);
    requests.push({
      path,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (path.endsWith("/token"))
      return Response.json({ token: "private-test-token" });
    if (path.endsWith("/models"))
      return Response.json({ data: [{ id: catalogModel, owned_by: "codex" }] });
    const response = results.shift();
    if (!response) throw new Error("Unexpected inference request");
    return response;
  };
  return { transport, requests };
}
function completion(content: string, finishReason = "stop") {
  return Response.json({
    model: "gpt-6.1-terra",
    service_tier: "default",
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 900,
      completion_tokens: 200,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 500 },
    },
  });
}
const valid = () =>
  completion(
    JSON.stringify({
      kind: "suggestion",
      text: "Исправь сохранение и проверь результат.",
    }),
  );

describe("companion bounded pilot", () => {
  it("builds every synthetic context through the production bundle and grounded memory", () => {
    expect(fixtures).toHaveLength(13);
    for (const fixture of fixtures) {
      const prepared = preparePilotCase(fixture, owner);
      expect(prepared.bundle.content).toContain(owner);
      const context = JSON.parse(prepared.context.text);
      expect(context.messages).toHaveLength(fixture.messages.length);
      if (fixture.seedIndex !== null)
        expect(context.priorState.goal.sources[0]).toEqual({
          messageId: prepared.context.messages[fixture.seedIndex]!.messageId,
          revision: prepared.context.messages[fixture.seedIndex]!.revision,
        });
    }
  });
  it.each([
    ["--live"],
    ["--max-calls", "0"],
    ["--max-calls", "21"],
    ["--max-output-tokens", "2049"],
    ["--max-calls", "2x"],
    ["--unknown", "x"],
    ["--origin", "https://external.example"],
    ["--model", model],
  ])("rejects unsafe or ambiguous arguments %j", (...args) => {
    expect(() => parsePilotArgs([...base, ...args])).toThrow();
  });
  it("does not call any transport in default dry run or expose instructions", async () => {
    const report = await runPilot(
      parsePilotArgs(base),
      fixtures,
      owner,
      async () => {
        throw new Error("Network forbidden");
      },
    );
    expect(report.calls).toEqual([]);
    expect(report.cases).toHaveLength(13);
    expect(JSON.stringify(report)).not.toContain(owner);
  });
  it("enforces call cap and records actual completion usage without persisting private inputs", async () => {
    const { transport, requests } = harness([valid(), valid()]);
    const report = await runPilot(live(), fixtures, owner, transport);
    expect(report.calls).toHaveLength(2);
    expect(
      requests.filter((request) => request.path.endsWith("/chat/completions")),
    ).toHaveLength(2);
    expect(report.calls[0]).toMatchObject({
      validation: "valid",
      actualModel: "gpt-6.1-terra",
      usage: {
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 500 },
      },
    });
    expect(JSON.stringify(report)).not.toContain("private-test-token");
    expect(JSON.stringify(report)).not.toContain(owner);
    const body = JSON.parse(requests[2]!.body!);
    expect(body.messages[0].content).toContain(owner);
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
  it.each([
    [() => new Response("invalid"), "envelope-json-error"],
    [() => Response.json({}), "envelope-schema-error"],
    [() => completion("invalid"), "result-json-error"],
    [() => completion('{"kind":"none","text":"extra"}'), "result-schema-error"],
    [() => completion("{}", "length"), "incomplete-or-oversized"],
    [
      () =>
        completion(
          JSON.stringify({
            kind: "none",
            state: {
              ...emptyTaskState(),
              goal: {
                text: "Fabricated source",
                sources: [
                  { messageId: "unavailable", revision: "a".repeat(64) },
                ],
              },
            },
          }),
        ),
      "result-schema-error",
    ],
  ])(
    "classifies response failures without retrying the same case",
    async (response, expected) => {
      const { transport } = harness([response(), valid()]);
      const report = await runPilot(live(), fixtures, owner, transport);
      expect(report.calls[0]?.validation).toBe(expected);
      expect(report.calls[1]?.id).toBe(fixtures[1]?.id);
    },
  );
  it("aborts on HTTP failure without retry or consuming remaining cases", async () => {
    const { transport } = harness([
      new Response("Sensitive gateway error", { status: 429 }),
      valid(),
    ]);
    const report = await runPilot(live(), fixtures, owner, transport);
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]).toMatchObject({
      validation: "http-error",
      status: 429,
    });
    expect(JSON.stringify(report)).not.toContain("Sensitive");
  });
  it("forwards the explicit output cap and only an explicitly enabled affinity", async () => {
    const options = parsePilotArgs([
      ...base,
      "--live",
      "--origin",
      "http://127.0.0.1:4000",
      "--output",
      "/report.json",
      "--max-calls",
      "1",
      "--max-output-tokens",
      "2048",
      "--session-affinity",
      "opaque-pilot-id",
    ]);
    const { transport, requests } = harness([valid()]);
    await runPilot(options, fixtures, owner, transport);
    expect(JSON.parse(requests[2]!.body!)).toMatchObject({
      max_completion_tokens: 2048,
      prompt_cache_key: "opaque-pilot-id",
      reasoning_effort: "none",
      service_tier: "default",
    });
  });
  it("rejects an uncapped non-Terra model before inference", async () => {
    const otherModel = "openrouter/text/host/profile/fast-model";
    const options = { ...live(), model: otherModel };
    const { transport, requests } = harness([], otherModel);
    await expect(runPilot(options, fixtures, owner, transport)).rejects.toThrow(
      "Zero output budget",
    );
    expect(requests).toHaveLength(2);
  });
  it("never falls back to another model", async () => {
    const { transport, requests } = harness([], "different-model");
    await expect(runPilot(live(), fixtures, owner, transport)).rejects.toThrow(
      "absent",
    );
    expect(requests).toHaveLength(2);
  });
  it("rejects ungrounded fixture seeds and malformed assertion patterns", () => {
    expect(() =>
      fixturesSchema.parse([{ ...fixtures[0], seedIndex: 1 }]),
    ).toThrow();
    expect(() =>
      fixturesSchema.parse([
        { ...fixtures[0], expected: { ...fixtures[0]!.expected, any: ["["] } },
      ]),
    ).toThrow();
  });
  it("does not count a source-valid unsupported claim as evidence", async () => {
    const fixture = fixtures.find(
      (item) => item.id === "valid-id-misrepresented-claim",
    )!;
    const source = preparePilotCase(fixture, owner).context.messages[1]!;
    const state = {
      ...emptyTaskState(),
      visibleEvidence: [
        {
          text: "Everything verified",
          sources: [{ messageId: source.messageId, revision: source.revision }],
        },
      ],
    };
    const { transport } = harness([
      completion(
        JSON.stringify(state),
      ),
    ]);
    const report = await runPilot({ ...live(), role: "memory" }, [fixture], owner, transport);
    expect(report.calls[0]).toMatchObject({
      validation: "valid",
      assertions: { evidence: false },
      screeningPassed: false,
    });
  });
  it("redacts decoded private owner strings recursively including quoted, escaped and short lines", async () => {
    const privateOwner =
      'Q7\nquote "private"\npath\\private\\key\n  padded-private  ';
    const fixture = fixtures[0]!;
    const source = preparePilotCase(fixture, privateOwner).context.messages[0]!;
    const fact = {
      text: privateOwner,
      sources: [{ messageId: source.messageId, revision: source.revision }],
    };
    const response = Response.json({
      model: privateOwner,
      service_tier: privateOwner,
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...emptyTaskState(), goal: fact, constraints: [fact],
            }),
          },
          finish_reason: "stop",
        },
      ],
    });
    const { transport } = harness([response]);
    const report = await runPilot({ ...live(), role: "memory" }, [fixture], privateOwner, transport);
    const call = report.calls[0]!;
    expect(call).toMatchObject({
      validation: "valid",
      actualModel: "",
      actualServiceTier: "",
      resultRepresentation: "validated-and-redacted-json",
      redactionApplied: true,
    });
    if (
      !("rawSyntheticResult" in call) ||
      typeof call.rawSyntheticResult !== "string"
    )
      throw new Error("Missing sanitized result");
    const decoded = JSON.parse(call.rawSyntheticResult!);
    expect(decoded.goal.text).toBe("");
    expect(decoded.constraints[0].text).toBe("");
    for (const line of privateOwner.split("\n")) {
      expect(JSON.stringify(report)).not.toContain(line);
      expect(JSON.stringify(report)).not.toContain(
        JSON.stringify(line).slice(1, -1),
      );
    }
  });
  it.each(["invalid-json", "invalid-schema", "invalid-source", "incomplete"])(
    "omits all private response content for %s",
    async (failure) => {
      const privateOwner = 'K9\nprivate "quoted"\nprivate\\escaped';
      const response =
        failure === "invalid-json"
          ? completion(privateOwner)
          : failure === "invalid-schema"
            ? completion(JSON.stringify({ text: privateOwner }))
            : failure === "incomplete"
              ? completion(privateOwner, "length")
              : completion(
                  JSON.stringify({
                    kind: "suggestion",
                    text: privateOwner,
                    state: {
                      ...emptyTaskState(),
                      goal: {
                        text: privateOwner,
                        sources: [
                          { messageId: "missing", revision: "a".repeat(64) },
                        ],
                      },
                    },
                  }),
                );
      const { transport } = harness([response]);
      const report = await runPilot(
        live(),
        [fixtures[0]!],
        privateOwner,
        transport,
      );
      expect(report.calls[0]).not.toHaveProperty("rawSyntheticResult");
      for (const line of privateOwner.split("\n")) {
        expect(JSON.stringify(report)).not.toContain(line);
        expect(JSON.stringify(report)).not.toContain(
          JSON.stringify(line).slice(1, -1),
        );
      }
    },
  );
  it("counts failed validation attempts against the inference call cap", async () => {
    const { transport, requests } = harness([
      completion("invalid"),
      completion("invalid"),
      valid(),
    ]);
    const report = await runPilot(live(), fixtures, owner, transport);
    expect(report.calls).toHaveLength(2);
    expect(
      report.calls.every((call) => call.validation === "result-json-error"),
    ).toBe(true);
    expect(
      requests.filter((request) => request.path.endsWith("/chat/completions")),
    ).toHaveLength(2);
  });
});
