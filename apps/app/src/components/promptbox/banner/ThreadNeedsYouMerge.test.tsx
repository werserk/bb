// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionNavigator } from "@/components/thread/user-questions/QuestionNavigator";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ComposerContextDock } from "../context/ComposerContextDock";
import {
  ComposerContextProvider,
  ComposerContextSources,
} from "../context/composer-context";
import { ThreadChildThreadsBanner } from "./ThreadPromptContextBanner";

const api = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { questions: { list: api.list, open: api.open } } },
}));
vi.mock("@/components/thread/user-questions/question-navigation", () => ({
  useQuestionNavigation: () => ({
    navigate: vi.fn().mockResolvedValue(true),
    error: null,
    pending: false,
    clear: vi.fn(),
  }),
}));

const question = (id: string, threadId: string) => ({
  id,
  createdAt: 1,
  status: "open",
  threadId,
  publication: { questions: [{ prompt: id }] },
});

beforeEach(() => {
  api.list.mockReset();
  api.open.mockReset().mockImplementation(async () => {
    const questions = (await api.list()).filter(
      (entry: ReturnType<typeof question>) => entry.threadId === "thr_test",
    );
    return {
      questions,
      total: questions.length,
      nextCursor: null,
      readRevision: "r1",
    };
  });
});

afterEach(cleanup);

const child = (id: string, needsOwnerAttention: boolean) => ({
  id,
  title: `Child ${id}`,
  href: `/threads/${id}`,
  needsOwnerAttention,
  updatedAt: Date.now() - 60_000,
});

it("counts this thread's open questions and waiting children once under Needs you", async () => {
  api.list.mockResolvedValue([
    question("Voice choice", "thr_test"),
    question("Tone choice", "thr_test"),
    question("Child's own question", "thr_child"),
  ]);
  render(
    <MemoryRouter>
      <ComposerContextProvider>
        <ComposerContextSources>
          <QuestionNavigator threadId="thr_test" />
          <ThreadChildThreadsBanner
            childThreads={{
              items: [child("a", true), child("b", true), child("c", false)],
            }}
            isExpanded={false}
            onExpandedChange={() => {}}
          />
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>
    </MemoryRouter>,
    { wrapper: createQueryClientTestHarness().wrapper },
  );
  const chip = await waitFor(() =>
    screen.getByRole("button", { name: "Needs you: 4" }),
  );
  expect(screen.getByRole("button", { name: "Working: 1" })).toBeTruthy();
  fireEvent.click(chip);
  const region = screen.getByRole("region", { name: "Thread context" });
  const heading = within(region).getAllByRole("heading")[0]!;
  expect(heading.textContent).toContain("Needs you");
  expect(heading.textContent).toContain("4");
  expect(within(region).getByRole("link", { name: /Child a/ })).toBeTruthy();
  expect(within(region).queryByText(/Child's own question/)).toBeNull();
});
