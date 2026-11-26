// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  backgroundCommandRow,
  workflowRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ComposerContextProvider,
  ComposerContextSources,
} from "./composer-context";
import { ComposerContextDock } from "./ComposerContextDock";
import {
  ThreadChildThreadsBanner,
  ThreadPromptContextBanner,
} from "../banner/ThreadPromptContextBanner";
import { ProviderRequirementBanner } from "../banner/ProviderRequirementBanner";
import { ThreadMachineStatusBanner } from "../banner/ThreadMachineStatus";
import { ThreadBackgroundCommandsCard } from "../banner/ThreadBackgroundCommandsCard";
import { ThreadWorkflowStack } from "../banner/ThreadWorkflowStack";
import { CollapsibleActiveStackCard } from "../banner/CollapsibleActiveStackCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(node: ReactNode, counter: string) {
  render(
    <MemoryRouter>
      <ComposerContextProvider>
        <ComposerContextSources>{node}</ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: counter }));
}
function row(title: string, action?: string) {
  const root = [
    ...document.querySelectorAll<HTMLElement>("[data-context-row]"),
  ].find((element) => element.textContent?.includes(title));
  expect(root).toBeTruthy();
  expect(root?.querySelector("svg")).toBeTruthy();
  if (action) expect(root?.textContent).toContain(action);
  return root;
}
it("uses one child row per thread and preserves links without answer forms", () => {
  mount(
    <ThreadChildThreadsBanner
      childThreads={{
        items: [
          {
            id: "child",
            title: "Inspect payments",
            href: "/threads/child",
            needsOwnerAttention: true,
          },
        ],
      }}
      isExpanded={false}
      onExpandedChange={vi.fn()}
    />,
    "Needs you: 1",
  );
  row("Inspect payments", "Open");
  expect(
    screen.getByRole("link", { name: /Inspect payments/ }).getAttribute("href"),
  ).toBe("/threads/child");
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
});
it.each(["parent", "fork"] as const)(
  "keeps the %s link in a flat row",
  (relationship) => {
    mount(
      <ThreadPromptContextBanner
        input={{ threadId: "t", projectId: "p", environment: null }}
        core={{
          parentThread: {
            parentThreadTitle: "Source thread",
            href: "/threads/source",
            relationship,
          },
        }}
        archivedSection={null}
        environmentGoneSection={null}
        expandedSegment={null}
        onToggleSegment={vi.fn()}
      />,
      "Parent",
    );
    row("Source thread", "Open");
    expect(
      screen.getByRole("link", { name: /Source thread/ }).getAttribute("href"),
    ).toBe("/threads/source");
  },
);
it.each(["archived", "environment"] as const)(
  "keeps the %s recovery action in a flat row",
  (kind) => {
    const action = vi.fn();
    const archived = kind === "archived";
    mount(
      <ThreadPromptContextBanner
        input={{ threadId: "t", projectId: "p", environment: null }}
        core={{ parentThread: null }}
        archivedSection={
          archived ? { archivedAt: 1, onUnarchive: action } : null
        }
        environmentGoneSection={
          !archived ? { status: "destroyed", onRestore: action } : null
        }
        expandedSegment={null}
        onToggleSegment={vi.fn()}
      />,
      archived ? "Thread is archived" : "Environment unavailable",
    );
    row(
      archived ? "Thread is archived" : "Environment unavailable",
      archived ? "Unarchive" : "Restore workspace",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: archived ? "Unarchive" : "Restore workspace",
      }),
    );
    expect(action).toHaveBeenCalledOnce();
  },
);
it("keeps provider requirements and their existing action in a warning row", () => {
  const action = vi.fn();
  mount(
    <ProviderRequirementBanner
      title="Connect a provider"
      description="A provider is required"
      action={<button onClick={action}>Connect</button>}
    />,
    "Connect a provider",
  );
  expect(
    row("Connect a provider", "Connect")?.querySelector("svg.text-attention"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(action).toHaveBeenCalledOnce();
});
it("keeps machine errors and retry in a warning row", () => {
  const resume = vi.fn();
  mount(
    <ThreadMachineStatusBanner
      host={{ name: "Lab", type: "ephemeral", machineProviderId: "lab" }}
      provider={undefined}
      phase="suspended"
      error="Could not resume"
      onResume={resume}
    />,
    "Machine status",
  );
  expect(row("Machine is paused", "Retry")?.textContent).toContain(
    "Could not resume",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(resume).toHaveBeenCalledOnce();
});
it("renders each background command as a mono row with elapsed time and no invented controls", () => {
  mount(
    <ThreadBackgroundCommandsCard
      commands={[
        backgroundCommandRow({
          description: "pnpm check",
          startedAt: Date.now() - 5000,
        }),
      ]}
      isExpanded={false}
      onToggle={vi.fn()}
    />,
    "Background commands: 1",
  );
  expect(row("pnpm check")?.querySelector(".font-mono")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Stop|Log|Details/ })).toBeNull();
});
it("keeps all workflows in one section and exposes each existing details action", () => {
  function Workflows() {
    const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
    return (
      <ThreadWorkflowStack
        workflows={[
          workflowRow({
            id: "wf",
            status: "pending",
            workflowName: "Review build",
            startedAt: Date.now(),
          }),
        ]}
        isStackExpanded={false}
        onToggleStack={vi.fn()}
        expandedWorkflowIds={ids}
        onToggleWorkflow={(id) =>
          setIds(ids.has(id) ? new Set() : new Set([id]))
        }
      />
    );
  }
  mount(<Workflows />, "Workflows: 1");
  row("Review build", "Details");
  const details = screen.getByRole("button", {
    name: "Workflow: Review build",
  });
  fireEvent.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("false");
});
it("keeps plugin-owned details and dismissal behind the same row actions", () => {
  const dismiss = vi.fn();
  function Banner() {
    const [open, setOpen] = useState(false);
    return (
      <CollapsibleActiveStackCard
        cardAriaLabel="Plugin activity"
        controlsAriaLabel="Plugin controls"
        toggleId="toggle"
        bodyId="body"
        toggleAriaLabel="Plugin details"
        iconName="Blocks"
        title="Inspect extension"
        isActive
        isExpanded={open}
        onToggle={() => setOpen(!open)}
        dismiss={{
          ariaLabel: "Dismiss extension",
          isPending: false,
          onDismiss: dismiss,
        }}
      >
        Extension details
      </CollapsibleActiveStackCard>
    );
  }
  mount(<Banner />, "Plugin activity");
  row("Inspect extension", "Details");
  fireEvent.click(screen.getByRole("button", { name: "Plugin details" }));
  expect(
    screen
      .getByRole("button", { name: "Plugin details" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss extension" }));
  expect(dismiss).toHaveBeenCalledOnce();
});
