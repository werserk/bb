// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent } from "@bb/shared-ui/dropdown-menu";
import {
  ThreadHeaderContributionsMenu,
  type HeaderContribution,
} from "./ThreadHeaderContributionsMenu";
import {
  activateHeaderComponent,
  partitionHeaderContributions,
  toggleHeaderPin,
} from "./threadHeaderPreferences";

afterEach(cleanup);

it("keeps unknown pins while filtering contributions and appending new pins", () => {
  const items = [{ key: "a/one" }, { key: "a/two" }];
  const keys = ["gone/action", "a/two"];
  expect(partitionHeaderContributions(items, keys)).toEqual({
    pinned: [items[1]],
    more: [items[0]],
  });
  expect(toggleHeaderPin(keys, "a/one")).toEqual([...keys, "a/one"]);
  expect(toggleHeaderPin(keys, "a/two")).toEqual(["gone/action"]);
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
            onToggle={(key) =>
              setKeys((previous) => toggleHeaderPin(previous, key))
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
