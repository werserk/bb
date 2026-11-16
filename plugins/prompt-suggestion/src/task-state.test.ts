import { it, expect } from "vitest";
import { contextInput, sourceMessage } from "./context-input.js";
import {
  emptyTaskState,
  taskStateSchema,
  validateStateSources,
  rememberTask,
} from "./task-state.js";

it("validates source identity and revision rather than trusting compact memory", () => {
  const message = sourceMessage("u", "user", "Ship locally", 1);
  const state = {
    ...emptyTaskState(),
    goal: {
      text: "Ship locally",
      sources: [{ messageId: message.messageId, revision: message.revision }],
    },
  };
  expect(() => validateStateSources(state, [message])).not.toThrow();
  expect(() =>
    validateStateSources(state, [
      { ...message, text: "Stop", revision: "0".repeat(64) },
    ]),
  ).toThrow();
  expect(() => validateStateSources(state, [])).toThrow();
  expect(taskStateSchema.safeParse({ ...state, arbitrary: true }).success).toBe(
    false,
  );
});

it("keeps grounded goal excerpts with recent messages, bounded as serialized input", () => {
  const first = sourceMessage("u", "user", "Make a local demo", 1);
  const state = {
    ...emptyTaskState(),
    goal: {
      text: "Local demo",
      sources: [{ messageId: first.messageId, revision: first.revision }],
    },
  };
  const memory = rememberTask(state, [first], null);
  const later = Array.from({ length: 20 }, (_, i) =>
    sourceMessage(`a${i}`, "assistant", "work ".repeat(40), i + 2),
  );
  const included = contextInput([first, ...later], 1600, memory, null, true);
  expect(included?.messages.some((message) => message.messageId === "u")).toBe(
    true,
  );
  expect(included?.text).toContain('"priorState":{"goal"');
  const input = contextInput(later, 1600, memory, null, true);
  expect(input?.text.length).toBeLessThanOrEqual(1600);
  expect(input?.messages.some((message) => message.messageId === "u")).toBe(
    true,
  );
  expect(input?.messages.at(-1)?.messageId).toBe("a19");
  expect(input?.contextComplete).toBe(false);
  expect(contextInput(later, 1600, memory, 2, true)?.text).not.toContain(
    "Local demo",
  );
});

it("never cuts a message or claims missing initial context is complete", () => {
  const messages = [
    sourceMessage("u", "user", "x".repeat(2000), 1),
    sourceMessage("a", "assistant", "Done", 2),
  ];
  const input = contextInput(messages, 1000, null, null, false);
  expect(input?.messages).toHaveLength(1);
  expect(input?.contextComplete).toBe(false);
  expect(contextInput([messages[0]!], 1000, null, null, false)).toBeNull();
});
