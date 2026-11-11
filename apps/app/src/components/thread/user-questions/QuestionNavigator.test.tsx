// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { BbHttpError } from "@bb/sdk/browser";
import { QuestionNavigator } from "./QuestionNavigator";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
  navigate: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { questions: { list: api.list, open: api.open } } },
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
beforeEach(() => {
  api.list.mockReset();
  api.open.mockReset().mockImplementation(async () => {
    const questions = (await api.list()).filter(
      (item: ReturnType<typeof q>) =>
        item.status === "open" && item.threadId === "thr_test",
    );
    return {
      questions,
      total: questions.length,
      nextCursor: null,
      readRevision: "r1",
    };
  });
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
  expect(screen.getByRole("status").textContent).toMatch(/Loading/);
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

it.each([
  { status: 404, code: null },
  { status: 400, code: "invalid_request" },
])(
  "labels a capped recent list on legacy response $status",
  async ({ status, code }) => {
    api.open.mockRejectedValue(
      new BbHttpError({
        status,
        message: "Invalid question id",
        code,
        body: null,
      }),
    );
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
        "Limited coverage · this core exposes recent history only. Older questions may remain in history.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Question · 0/ })).toBeNull();
  },
);

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

it("loads an older open question through canonical pages and shows server total", async () => {
  const first = {
    questions: [q("Newest", 2)],
    total: 201,
    nextCursor: "next",
    readRevision: "r1",
  };
  api.open.mockResolvedValue(first).mockImplementation(async ({ cursor }) =>
    cursor
      ? {
          questions: [q("Oldest", 1)],
          total: 201,
          nextCursor: null,
          readRevision: "r1",
        }
      : first,
  );
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Questions · 201/ }),
  );
  expect(await screen.findByText("Showing 1 of 201")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  fireEvent.click(await screen.findByRole("button", { name: "Oldest" }));
  expect(api.navigate).toHaveBeenCalledWith("Oldest", "question");
  expect(api.list).not.toHaveBeenCalled();
});

it("hides a retained numeric total after 30 seconds without a successful read", async () => {
  const harness = createQueryClientTestHarness();
  harness.queryClient.setQueryData(
    ["conversationQuestions", "thr_test", "open"],
    {
      questions: [q("Retained", 1)],
      total: 23,
      nextCursor: "next",
      incomplete: false,
      legacy: false,
    },
    { updatedAt: Date.now() - 31_000 },
  );
  api.open.mockRejectedValue(new Error("offline"));
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: harness.wrapper,
  });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: /Questions · 23/ })).toBeNull();
  expect(screen.queryByText("0 open questions")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("shows Retry after two changing cursor snapshots instead of mixing question lists", async () => {
  const first = {
    questions: [q("Discarded", 2)],
    total: 201,
    nextCursor: "next",
    readRevision: "r1",
  };
  const second = {
    questions: [q("Current", 3)],
    total: 201,
    nextCursor: "next2",
    readRevision: "r2",
  };
  const changed = () =>
    new BbHttpError({
      status: 409,
      code: "stale-question-cursor",
      message: "changed",
      body: null,
    });
  api.open
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(changed())
    .mockResolvedValueOnce(second)
    .mockRejectedValueOnce(changed());
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Questions · 201/ }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText(/The list keeps changing/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Discarded" })).toBeNull();
  expect(screen.getByRole("button", { name: "Current" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(api.open).toHaveBeenCalledTimes(5);
});

it("does not treat an unrelated client error as legacy coverage", async () => {
  api.open.mockRejectedValue(
    new BbHttpError({
      status: 400,
      message: "Denied",
      code: "permission_denied",
      body: null,
    }),
  );
  render(<QuestionNavigator threadId="thr_test" />, {
    wrapper: createQueryClientTestHarness().wrapper,
  });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(api.list).not.toHaveBeenCalled();
});
