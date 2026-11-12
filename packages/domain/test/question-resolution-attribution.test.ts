import { expect, it } from "vitest";
import {
  questionResolutionActorLabel,
  questionResolutionLabel,
} from "../src/question-resolution-attribution.js";

it("keeps an agent-controlled name distinct from owner attribution", () => {
  const actor = {
    kind: "agent",
    verification: "runtime",
    threadId: "thr_actor",
    projectId: "proj_test",
    name: "you",
    role: "builder",
  } as const;
  expect(questionResolutionLabel({ action: "answer", actor })).toBe(
    "Answered by Agent: you",
  );
  expect(questionResolutionActorLabel(actor)).toBe("Agent: you (thr_actor)");
});
