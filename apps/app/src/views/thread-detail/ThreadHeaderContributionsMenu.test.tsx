// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent } from "@bb/shared-ui/dropdown-menu";
import {
  ThreadHeaderContributionsMenu,
  type HeaderContribution,
} from "./ThreadHeaderContributionsMenu";
import {
  activateHeaderComponent,
  partitionHeaderContributions,
  setHeaderPin,
} from "./threadHeaderPreferences";

const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewport.compact,
}));
beforeEach(() => {
  viewport.compact = false;
});

afterEach(cleanup);

it("keeps unknown pins while filtering contributions and appending new pins", () => {
  const items = [{ key: "a/one" }, { key: "a/two" }];
  const keys = ["gone/action", "a/two"];
  expect(partitionHeaderContributions(items, keys)).toEqual({
    pinned: [items[1]],
    more: [items[0]],
  });
  expect(setHeaderPin(keys, "a/one", true)).toEqual([...keys, "a/one"]);
  expect(setHeaderPin(keys, "a/two", true)).toEqual(keys);
  expect(setHeaderPin(keys, "a/two", false)).toEqual(["gone/action"]);
  expect(setHeaderPin(keys, "a/one", false)).toEqual(keys);
});

it("activates the first enabled interactive element in the requested instance", () => {
  const run = vi.fn();
  const view = render(
    <div hidden>
      <button disabled>Unavailable</button>
      <button onClick={run}>Tasks</button>
      <button
        onClick={() => {
          throw new Error("wrong target");
        }}
      >
        Other
      </button>
    </div>,
  );
  activateHeaderComponent(view.container);
  expect(run).toHaveBeenCalledTimes(1);
  activateHeaderComponent(undefined);
});

it("moves rows between sections without closing and runs the action separately", () => {
  const run = vi.fn(async () => {});
  const items: HeaderContribution[] = [
    {
      key: "wprojects/threads",
      label: "Tasks · WProjects",
      action: { label: "Tasks", icon: "List", run },
    },
  ];
  function Menu() {
    const [keys, setKeys] = useState<string[]>([]);
    return (
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <ThreadHeaderContributionsMenu
            {...partitionHeaderContributions(items, keys)}
            onPinChange={(key, pinned) =>
              setKeys((previous) => setHeaderPin(previous, key, pinned))
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  render(<Menu />);
  expect(screen.queryByText("In header")).toBeNull();
  expect(screen.getByText("More actions")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Pin to header: Tasks · WProjects" }),
  );
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByText("In header")).toBeTruthy();
  expect(screen.queryByText("More actions")).toBeNull();
  fireEvent.click(
    screen.getByRole("menuitem", {
      name: "Unpin from header: Tasks · WProjects",
    }),
  );
  expect(screen.getByText("More actions")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Tasks · WProjects" }));
  expect(run).toHaveBeenCalledTimes(1);
});

it("keeps keyboard focus on the moved pin button and supports arrow navigation", async () => {
  const items: HeaderContribution[] = [
    {
      key: "wprojects/threads",
      label: "Tasks · WProjects",
      action: { label: "Tasks", icon: "List", run: vi.fn(async () => {}) },
    },
    {
      key: "plugin/other",
      label: "Other",
      action: { label: "Other", icon: "List", run: vi.fn(async () => {}) },
    },
  ];
  function Menu() {
    const [keys, setKeys] = useState<string[]>([]);
    return (
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <ThreadHeaderContributionsMenu
            {...partitionHeaderContributions(items, keys)}
            onPinChange={(key, pinned) =>
              setKeys((previous) => setHeaderPin(previous, key, pinned))
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  render(<Menu />);
  for (const [before, after] of [
    ["Pin to header", "Unpin from header"],
    ["Unpin from header", "Pin to header"],
  ]) {
    const pin = screen.getByRole("menuitem", {
      name: `${before}: Tasks · WProjects`,
    });
    pin.focus();
    fireEvent.keyDown(pin, { key: "Enter" });
    const moved = screen.getByRole("menuitem", {
      name: `${after}: Tasks · WProjects`,
    });
    expect(document.activeElement).toBe(moved);
    fireEvent.keyDown(moved, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Other" }),
      ),
    );
  }
});

it.each([false, true])(
  "keeps one preferred Open row and opens its target submenu (compact: %s)",
  async (compact) => {
    viewport.compact = compact;
    const openCode = vi.fn();
    const openTerminal = vi.fn();
    const onPinChange = vi.fn();
    const item: HeaderContribution = {
      key: "bb--core/open",
      label: "Open in VS Code",
      action: { label: "Open in VS Code", icon: "FolderOpen", run: openCode },
      menuActions: [
        { id: "code", label: "Open in VS Code", run: openCode },
        { id: "terminal", label: "Open in Terminal", run: openTerminal },
      ],
    };
    const view = render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <ThreadHeaderContributionsMenu
            pinned={[]}
            more={[item]}
            onPinChange={onPinChange}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const primary = await screen.findByRole("menuitem", {
      name: "Open in VS Code",
    });
    expect(
      screen.queryByRole("menuitem", { name: "Open in Terminal" }),
    ).toBeNull();
    const pin = screen.getByRole("menuitem", {
      name: "Pin to header: Open in VS Code",
    });
    fireEvent.click(pin);
    expect(onPinChange).toHaveBeenCalledWith("bb--core/open", true);
    expect(openCode).not.toHaveBeenCalled();
    const trigger = screen.getByRole("menuitem", {
      name: "Choose Open target",
    });
    primary.focus();
    fireEvent.keyDown(primary, { key: "ArrowRight" });
    const terminal = await screen.findByRole("menuitem", {
      name: "Open in Terminal",
    });
    terminal.focus();
    fireEvent.keyDown(terminal, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(
      screen.queryByRole("menuitem", { name: "Open in Terminal" }),
    ).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open in Terminal" }),
    );
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(openCode).not.toHaveBeenCalled();
    view.unmount();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <ThreadHeaderContributionsMenu
            pinned={[item]}
            more={[]}
            onPinChange={onPinChange}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open in VS Code" }),
    );
    expect(openCode).toHaveBeenCalledTimes(1);
  },
);
