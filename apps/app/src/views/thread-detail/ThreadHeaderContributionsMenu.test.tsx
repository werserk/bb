// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
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

it("opens each workspace target and pins the shared Open contribution", () => {
  const openCode = vi.fn();
  const openTerminal = vi.fn();
  const onPinChange = vi.fn();
  const item: HeaderContribution = {
    key: "bb--core/open",
    label: "Open workspace",
    action: {
      label: "Open workspace",
      icon: "FolderOpen",
      run: vi.fn(async () => {}),
    },
    menuActions: [
      { id: "code", label: "Open workspace in VS Code", run: openCode },
      {
        id: "terminal",
        label: "Open workspace in Terminal",
        run: openTerminal,
      },
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
  fireEvent.click(
    screen.getByRole("menuitem", {
      name: "Pin to header: Open workspace in Terminal",
    }),
  );
  expect(onPinChange).toHaveBeenCalledWith("bb--core/open", true);
  expect(openTerminal).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Open workspace in Terminal" }),
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
    screen.getByRole("menuitem", { name: "Open workspace in VS Code" }),
  );
  expect(openCode).toHaveBeenCalledTimes(1);
});
