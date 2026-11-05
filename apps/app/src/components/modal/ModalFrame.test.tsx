// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCoreModal,
  registerCoreModal,
  resetModalHostForTest,
} from "@/lib/modal-host";
import { ModalHost } from "./ModalHost";

type Listener = () => void;
interface FakeQuery {
  matches: boolean;
  listeners: Set<Listener>;
}

const queries = new Map<string, FakeQuery>();
const viewport = { compact: false, coarse: false };
const mounts = { body: 0 };

function matchesFor(query: string): boolean {
  if (query === "(max-width: 767px)") return viewport.compact;
  if (query === "(pointer: coarse)") return viewport.coarse;
  return false;
}

function installMatchMedia() {
  queries.clear();
  window.matchMedia = ((query: string) => {
    let entry = queries.get(query);
    if (entry === undefined) {
      entry = { matches: matchesFor(query), listeners: new Set() };
      queries.set(query, entry);
    }
    const current = entry;
    return {
      get matches() {
        return current.matches;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: Listener) => {
        current.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: Listener) => {
        current.listeners.delete(listener);
      },
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

function setCompact(compact: boolean) {
  viewport.compact = compact;
  const entry = queries.get("(max-width: 767px)");
  if (entry === undefined) return;
  entry.matches = compact;
  for (const listener of entry.listeners) listener();
}

function FormBody({ params }: { params: unknown }) {
  useEffect(() => {
    mounts.body += 1;
  }, []);
  return (
    <form>
      <input aria-label="First field" />
      <input aria-label="Second field" data-autofocus="" />
      <span data-testid="params">{JSON.stringify(params)}</span>
    </form>
  );
}

function PlainBody() {
  return <p>Nothing to type</p>;
}

function Harness() {
  return (
    <BrowserRouter>
      <button type="button">Opener</button>
      <ModalHost />
    </BrowserRouter>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  viewport.compact = false;
  viewport.coarse = false;
  mounts.body = 0;
  installMatchMedia();
  registerCoreModal("core/form", FormBody);
  registerCoreModal("core/plain", PlainBody);
});

afterEach(() => {
  cleanup();
  resetModalHostForTest();
});

describe("ModalFrame on desktop", () => {
  it("shows breadcrumb, Esc keycap and Close, and focuses the data-autofocus field", async () => {
    render(<Harness />);
    act(() =>
      openCoreModal("core/form", { title: "Project settings", context: "E2E" }),
    );
    await settle();

    expect(
      screen.getByRole("dialog", { name: /E2E \/ Project settings/ }),
    ).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("First field"));
  });

  it("falls back to the panel when the body has no field", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    expect(document.activeElement?.getAttribute("data-bb-modal-panel")).toBe(
      "",
    );
  });

  it("hides the Esc keycap on a coarse pointer", async () => {
    viewport.coarse = true;
    installMatchMedia();
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    expect(screen.queryByText("Esc")).toBeNull();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByText("Opener");
    opener.focus();
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await settle();

    expect(screen.queryByText("Nothing to type")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the Close button", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    fireEvent.click(screen.getByLabelText("Close"));
    await settle();

    expect(screen.queryByText("Nothing to type")).toBeNull();
    expect(window.history.state?.usr?.bbModal).toBeUndefined();
  });

  it("uses the panel size and scrim classes", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("w-[min(1040px,calc(100vw-48px))]");
    expect(dialog.className).toContain("h-[min(740px,calc(100dvh-48px))]");
    expect(document.querySelector("[class*='--surface-scrim']")).not.toBeNull();
  });
});

describe("ModalFrame as a phone sheet", () => {
  beforeEach(() => {
    viewport.compact = true;
    installMatchMedia();
  });

  it("focuses a data-autofocus field only when the body opts in", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/form", { title: "Settings" }));
    await settle();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Second field"),
      ),
    );
  });

  it("focuses the panel after the content is realised, not a field", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Settings" }));
    expect(screen.queryByText("Nothing to type")).toBeNull();
    await settle();

    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-bb-modal-panel")).toBe(
        "",
      ),
    );
    expect(screen.getByLabelText("Close")).toBeTruthy();
    expect(screen.queryByText("Esc")).toBeNull();
  });

  it("closes on Escape and from the back arrow", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await settle();
    expect(window.history.state?.usr?.bbModal).toBeUndefined();

    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();
    expect(window.history.state?.usr?.bbModal).toBeDefined();
    fireEvent.click(screen.getByLabelText("Close"));
    await settle();
    expect(window.history.state?.usr?.bbModal).toBeUndefined();
  });

  it("uses the sheet height and the shared scrim class", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/plain", { title: "Plain" }));
    await settle();

    const panel = document.querySelector("[data-persistent-drawer-content]");
    expect(panel?.className).toContain("h-[calc(100dvh-44px)]");
    expect(
      document
        .querySelector("[data-persistent-drawer-backdrop]")
        ?.className.includes("--surface-scrim"),
    ).toBe(true);
  });
});

describe("viewport crossing 768", () => {
  it("remounts the body on the same entry with the same params", async () => {
    render(<Harness />);
    act(() =>
      openCoreModal("core/form", { title: "Settings", params: { n: 4 } }),
    );
    await settle();
    const length = window.history.length;
    const token = window.history.state.usr.bbModal.token;
    expect(mounts.body).toBe(1);

    act(() => setCompact(true));
    await settle();

    expect(mounts.body).toBe(2);
    expect(screen.getByTestId("params").textContent).toBe('{"n":4}');
    expect(window.history.length).toBe(length);
    expect(window.history.state.usr.bbModal.token).toBe(token);
  });
});
