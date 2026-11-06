// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { splitLayoutAtom, maximizedPaneIdAtom } from "@/lib/split-layout/atoms";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import {
  ThreadChildThreadsBanner,
  ThreadChildQuestionCards,
  type ChildThreadQuestion,
  type ThreadPromptChildThreadsSection,
} from "./ThreadPromptContextBanner";

const mocks = vi.hoisted(() => ({
  resolveHook: vi.fn(),
  resolve: vi.fn(async () => ({})),
}));

vi.mock("@/hooks/mutations/thread-interaction-mutations", () => ({
  useResolveThreadPendingInteraction: (threadId: string) => {
    mocks.resolveHook(threadId);
    return { mutateAsync: mocks.resolve, isPending: false, error: null };
  },
  useCancelThreadPendingInteraction: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { interactions: { respond: vi.fn(), cancel: vi.fn() } } },
}));

function childQuestion(
  childThreadId: string,
  prompt: string,
  createdAt: number,
): ChildThreadQuestion {
  const interaction: PendingInteraction = {
    id: `pint_${childThreadId}`,
    threadId: childThreadId,
    turnId: "turn_1",
    providerId: "claude-code",
    providerThreadId: "pt_1",
    providerRequestId: `req_${childThreadId}`,
    status: "pending",
    statusReason: null,
    createdAt,
    resolvedAt: null,
    resolution: null,
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "choice",
          prompt,
          multiSelect: false,
          allowFreeText: false,
          required: true,
          options: [
            { value: "a", label: "Alpha", description: "First choice" },
            { value: "b", label: "Beta", description: "Second choice" },
          ],
        },
      ],
    },
  };
  return {
    childThreadId,
    childTitle: `Child ${childThreadId}`,
    href: `/threads/${childThreadId}`,
    interaction,
  };
}

const newest = childQuestion("thr_b", "Which size?", 3);
const middle = childQuestion("thr_c", "Which shape?", 2);

function section(
  pendingInteractions: readonly ChildThreadQuestion[],
): ThreadPromptChildThreadsSection {
  return {
    items: [
      ...pendingInteractions.map((item) => ({
        id: item.childThreadId,
        title: item.childTitle,
        href: item.href,
        hasPendingInteraction: true,
      })),
      {
        id: "thr_working",
        title: "Investigate failing checks",
        href: "/threads/thr_working",
        hasPendingInteraction: false,
      },
    ],
    pendingInteractions,
  };
}

function Harness({
  childThreads,
  initiallyExpanded,
}: {
  childThreads: ThreadPromptChildThreadsSection;
  initiallyExpanded: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  return (
    <ThreadChildThreadsBanner
      childThreads={childThreads}
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
    />
  );
}

function bannerElement(
  childThreads: ThreadPromptChildThreadsSection,
  initiallyExpanded = true,
  queryClient = new QueryClient(),
) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Harness
          childThreads={childThreads}
          initiallyExpanded={initiallyExpanded}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.resolveHook.mockClear();
  mocks.resolve.mockClear();
});

describe("child question announcements", () => {
  it("shows counts without question text or an answer path in the child strip", () => {
    render(bannerElement(section([newest, middle])));
    expect(screen.getByText("2 needs you · 1 working")).toBeTruthy();
    expect(screen.getByRole("button", { name: /2 needs you/ })).toBeTruthy();
    expect(screen.queryByText(/Which size/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Child thr_b/ })).toBeNull();
    expect(screen.queryByTestId("user-question-banner")).toBeNull();
    expect(screen.getByText("Investigate failing checks")).toBeTruthy();
  });
});

function cards(
  questions: readonly ChildThreadQuestion[],
  ownInteractions: readonly PendingInteraction[] = [],
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadChildQuestionCards
          questions={questions}
          ownInteractions={ownInteractions}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it("relays one answer card per interaction and submits to the original child", async () => {
  render(cards([newest, newest]));
  expect(screen.getAllByTestId("user-question-banner")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /^Alpha/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
  expect(mocks.resolve).toHaveBeenCalledWith({
    threadId: "thr_b",
    interactionId: "pint_thr_b",
    resolution: {
      kind: "user_answer",
      answers: { choice: { selected: ["a"] } },
    },
  });
});

it("omits the relay when the question already has an own card", () => {
  render(cards([newest], [newest.interaction]));
  expect(screen.queryByTestId("user-question-banner")).toBeNull();
});

it("limits answer cards to three and opens the remaining threads as a list", () => {
  const questions = Array.from({ length: 5 }, (_, index) =>
    childQuestion(`thr_${index}`, `Question ${index}?`, 5 - index),
  );
  const { rerender } = render(cards([...questions, questions[4]!]));
  expect(screen.getAllByTestId("user-question-banner")).toHaveLength(3);
  const more = screen.getByText("+2 more need you");
  expect(more.closest("details")?.open).toBe(false);
  fireEvent.click(more);
  expect(more.closest("details")?.open).toBe(true);
  expect(
    screen.getByRole("link", { name: "Child thr_3" }).getAttribute("href"),
  ).toBe("/threads/thr_3");
  expect(
    screen.getByRole("link", { name: "Child thr_4" }).getAttribute("href"),
  ).toBe("/threads/thr_4");
  expect(screen.getAllByTestId("user-question-banner")).toHaveLength(3);

  rerender(
    cards(
      questions.map((question, index) =>
        index < 2
          ? {
              ...question,
              interaction: { ...question.interaction, status: "resolved" },
            }
          : question,
      ),
    ),
  );
  expect(screen.getAllByTestId("user-question-banner")).toHaveLength(3);
  expect(screen.queryByText(/more need you/)).toBeNull();
  expect(screen.getAllByText("Question 4?")).toHaveLength(2);
});

it("clears the relay after an answer arrives from another view", () => {
  const { rerender } = render(cards([newest]));
  expect(screen.getByTestId("user-question-banner")).toBeTruthy();
  rerender(
    cards([
      { ...newest, interaction: { ...newest.interaction, status: "resolved" } },
    ]),
  );
  expect(screen.queryByTestId("user-question-banner")).toBeNull();
});

it("shows the question only in the child's pane when parent and child are visible together", () => {
  const store = createStore();
  const view = () => <Provider store={store}>{cards([newest])}</Provider>;
  render(view());
  act(() =>
    store.set(splitLayoutAtom, {
      focusedPaneId: "parent",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "parent",
            content: {
              kind: "thread",
              projectId: "proj_1",
              threadId: "thr_parent",
            },
          },
          {
            type: "pane",
            paneId: "child",
            content: { kind: "thread", projectId: "proj_1", threadId: "thr_b" },
          },
        ],
      },
    }),
  );
  expect(screen.queryByTestId("user-question-banner")).toBeNull();
  // A hidden child pane cannot own the answer path.
  act(() => store.set(maximizedPaneIdAtom, "parent"));
  expect(screen.getByTestId("user-question-banner")).toBeTruthy();
});
