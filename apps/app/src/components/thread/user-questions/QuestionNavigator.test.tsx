// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { QuestionNavigator } from "./QuestionNavigator";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  navigate: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { questions: { list: api.list } } },
}));
vi.mock("./question-navigation", () => ({
  useQuestionNavigation: () => ({
    navigate: api.navigate,
    error: null,
    pending: false,
    clear: vi.fn(),
  }),
}));
const q = (
  id: string,
  createdAt: number,
  status = "open",
  threadId = "thr_test",
) => ({
  id,
  createdAt,
  status,
  threadId,
  publication: { questions: [{ prompt: id }] },
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("distinguishes loading from no open questions and excludes settled and child cards", async () => {
  let resolve!: (value: unknown[]) => void;
  api.list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  expect(screen.getByText(/Loading/)).toBeTruthy();
  resolve([q("settled", 1, "answered"), q("child", 2, "open", "thr_child")]);
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
  expect(screen.queryByRole("button", { name: /Question/ })).toBeNull();
});
it("navigates directly for one publication even if that publication has multiple fields", async () => {
  api.list.mockResolvedValue([q("Voice choice", 1)]);
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(await screen.findByRole("button", { name: /Question · 1/ }));
  expect(api.navigate).toHaveBeenCalledWith("Voice choice", "question");
});
it("lists multiple publications in creation order", async () => {
  api.list.mockResolvedValue([q("Newest", 2), q("Oldest", 1)]);
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(await screen.findByRole("button", { name: /Questions · 2/ }));
  const old = await screen.findByRole("button", { name: "Oldest" });
  expect(
    old.compareDocumentPosition(
      screen.getByRole("button", { name: "Newest" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(old);
  await waitFor(() =>
    expect(api.navigate).toHaveBeenCalledWith("Oldest", "question"),
  );
});
it("shows an actionable load error and refetches without submitting an answer", async () => {
  api.list.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(api.navigate).not.toHaveBeenCalled();
});

it("labels a capped recent list instead of implying that older questions are absent", async () => {
  api.list.mockResolvedValue(
    Array.from({ length: 200 }, (_, index) =>
      q(`Closed ${index}`, index, "answered"),
    ),
  );
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  expect(
    await screen.findByText(
      "Showing the latest 200 cards. Older questions may remain in history.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Question · 0/ })).toBeNull();
});

it("uses the same short label as the destination card for direct and list navigation", async () => {
  const labeled = {
    ...q("Full prompt", 1),
    publication: {
      questions: [{ prompt: "Full prompt", shortLabel: "Decision" }],
    },
  };
  api.list.mockResolvedValue([labeled]);
  const first = render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  expect(
    await screen.findByRole("button", { name: /Question · 1 Decision/ }),
  ).toBeTruthy();
  first.unmount();
  api.list.mockResolvedValue([labeled, q("Other", 2)]);
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(await screen.findByRole("button", { name: /Questions · 2/ }));
  expect(await screen.findByRole("button", { name: "Decision" })).toBeTruthy();
});
