// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QuestionResolutionAttribution } from "@bb/domain";
import { HttpError } from "@/lib/api";
import { QuestionResolutionDetails } from "./QuestionResolutionDetails";

const current = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ error: current.error }),
}));
const resolution: QuestionResolutionAttribution = {
  id: "qres_actor",
  targetKind: "qst",
  targetId: "qst_actor",
  threadId: "thr_asker",
  revision: 1,
  operationId: "answer-1",
  action: "answer",
  actor: {
    kind: "agent",
    verification: "runtime",
    threadId: "thr_coordinator",
    projectId: "proj_original",
    name: "Frozen coordinator",
    role: "coordinator",
  },
  reason: "Already settled",
  acceptedAt: 2000,
  answers: {},
  deliveryId: "qmsg_notice",
};
afterEach(() => {
  cleanup();
  current.error = null;
});
it("preserves recorded identity but removes navigation after a confirmed actor 404", () => {
  current.error = new HttpError({ status: 404, message: "Thread not found" });
  render(<QuestionResolutionDetails resolution={resolution} showIdentity />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/Link unavailable/)).toBeTruthy();
  expect(screen.getByText(/Frozen coordinator/).textContent).toContain(
    "thr_coordinator",
  );
});
it.each([null, new Error("Network unavailable")])(
  "does not infer deletion from missing data or a transport failure (%s)",
  (error) => {
    current.error = error;
    render(<QuestionResolutionDetails resolution={resolution} showIdentity />);
    expect(screen.getByRole("link").getAttribute("href")).toContain(
      "thr_coordinator",
    );
    expect(screen.queryByText(/Link unavailable/)).toBeNull();
    expect(screen.getByText(/Recorded actor/).textContent).toContain(
      "Frozen coordinator",
    );
  },
);
