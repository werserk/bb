// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import type {
  ExperimentalModalHandle,
  ExperimentalModalProps,
} from "@get-bb/plugin-sdk";
import { definePluginApp } from "@/lib/plugin-app-definition";
import {
  closeModal,
  openCoreModal,
  registerCoreModal,
  resetModalHostForTest,
} from "@/lib/modal-host";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { LocationProbe } from "@/test/location-probe";
import { ModalHost } from "./ModalHost";

const mounts = { body: 0, page: 0 };
let go: ReturnType<typeof navigateSpy>;
let navigateTo: (to: string) => void = () => {};

function navigateSpy() {
  return vi.spyOn(window.history, "go");
}

function Body({ params, close }: ExperimentalModalProps) {
  useEffect(() => {
    mounts.body += 1;
  }, []);
  return (
    <div data-testid="body">
      <span data-testid="params">{JSON.stringify(params)}</span>
      <button type="button" onClick={close}>
        Close from body
      </button>
    </div>
  );
}

function Page() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (to) => void navigate(to);
  }, [navigate]);
  useEffect(() => {
    mounts.page += 1;
  }, []);
  return <LocationProbe />;
}

function Harness() {
  return (
    <BrowserRouter>
      <Page />
      <ModalHost />
    </BrowserRouter>
  );
}

function modalToken(): string | null {
  return window.history.state?.usr?.bbModal?.token ?? null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function registerPlugin(): ExperimentalModalHandle {
  let handle: ExperimentalModalHandle | undefined;
  const collected = collectPluginAppRegistrations(
    definePluginApp((app) => {
      handle = app.slots.experimental_modal({
        id: "settings",
        component: Body,
      });
    }),
    undefined,
    "alpha",
  );
  setPluginSlotRegistrations(
    "alpha",
    registrationSet({ modals: collected.modals }),
  );
  if (handle === undefined) throw new Error("no handle");
  return handle;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  mounts.body = 0;
  mounts.page = 0;
  registerCoreModal("core/test", Body);
  go = navigateSpy();
});

afterEach(() => {
  cleanup();
  go.mockRestore();
  resetModalHostForTest();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});

describe("ModalHost history rules", () => {
  it("opens with one push on the same URL", async () => {
    render(<Harness />);
    const before = window.history.length;

    act(() =>
      openCoreModal("core/test", { title: "Settings", params: { a: 1 } }),
    );
    await settle();

    expect(window.history.length).toBe(before + 1);
    expect(window.location.pathname).toBe("/");
    expect(screen.getByTestId("params").textContent).toBe('{"a":1}');
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("replaces the showing modal and remounts the body for new params", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "One", params: { n: 1 } }));
    await settle();
    const length = window.history.length;
    const first = modalToken();

    act(() => openCoreModal("core/test", { title: "Two", params: { n: 2 } }));
    await settle();

    expect(window.history.length).toBe(length);
    expect(modalToken()).not.toBe(first);
    expect(screen.getByTestId("params").textContent).toBe('{"n":2}');
    expect(mounts.body).toBe(2);
  });

  it("turns two opens in one tick into one entry", async () => {
    render(<Harness />);
    const before = window.history.length;

    act(() => {
      openCoreModal("core/test", { title: "A", params: { n: 1 } });
      openCoreModal("core/test", { title: "B", params: { n: 2 } });
    });
    await settle();

    expect(window.history.length).toBe(before + 1);
    expect(screen.getByTestId("params").textContent).toBe('{"n":2}');
  });

  it("closes with one pop and ignores a second close before the pop", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A" }));
    await settle();

    act(() => {
      closeModal();
      closeModal();
    });
    await settle();

    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-1);
    expect(modalToken()).toBeNull();
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("queues an open that follows a close until the pop lands", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A", params: { n: 1 } }));
    await settle();
    const length = window.history.length;

    act(() => {
      closeModal();
      openCoreModal("core/test", { title: "B", params: { n: 2 } });
    });
    await settle();

    expect(go).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(length);
    expect(screen.getByTestId("params").textContent).toBe('{"n":2}');
  });

  it("gives the body null params when none are passed", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A" }));
    await settle();

    expect(screen.getByTestId("params").textContent).toBe("null");
    expect(window.history.state.usr.bbModal.params).toBeNull();
  });

  it("keeps deferring an open while the modal is still in history after the fallback delay", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A", params: { n: 1 } }));
    await settle();
    const first = modalToken();
    go.mockImplementation(() => {});

    act(() => {
      closeModal();
      openCoreModal("core/test", { title: "B", params: { n: 2 } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(modalToken()).toBe(first);

    go.mockRestore();
    go = navigateSpy();
    act(() => window.history.back());
    await settle();

    expect(screen.getByTestId("params").textContent).toBe('{"n":2}');
  });

  it("reopens on forward with the params of the entry", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A", params: { n: 7 } }));
    await settle();
    act(() => closeModal());
    await settle();
    expect(screen.queryByTestId("body")).toBeNull();

    act(() => window.history.forward());
    await settle();

    expect(screen.getByTestId("params").textContent).toBe('{"n":7}');
  });

  it("closes on a route change and reopens on back", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A", params: { n: 3 } }));
    await settle();

    act(() => navigateTo("/elsewhere"));
    await settle();
    expect(screen.queryByTestId("body")).toBeNull();

    act(() => window.history.back());
    await settle();
    expect(screen.getByTestId("params").textContent).toBe('{"n":3}');
  });

  it("does not remount the page subtree on open and close", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A" }));
    await settle();
    act(() => closeModal());
    await settle();

    expect(mounts.page).toBe(1);
  });

  it("closes from the body through the close prop", async () => {
    render(<Harness />);
    act(() => openCoreModal("core/test", { title: "A" }));
    await settle();

    fireEvent.click(screen.getByText("Close from body"));
    await settle();

    expect(modalToken()).toBeNull();
  });
});

describe("ModalHost cleanup", () => {
  it("replaces a modal entry whose token this page never opened", async () => {
    window.history.replaceState(
      {
        usr: {
          keep: 1,
          bbModal: {
            v: 1,
            token: "from-before-reload",
            kind: "core",
            modalId: "core/test",
            title: "Old",
            params: {},
          },
        },
        key: "k",
        idx: 0,
      },
      "",
      "/",
    );
    const length = window.history.length;

    render(<Harness />);
    await settle();

    expect(screen.queryByTestId("body")).toBeNull();
    expect(window.history.state.usr).toEqual({ keep: 1 });
    expect(window.history.length).toBe(length);
    expect(go).not.toHaveBeenCalled();
  });

  it("replaces the entry when the plugin registration disappears", async () => {
    const handle = registerPlugin();
    render(<Harness />);
    act(() => handle.open("settings", { title: "Plugin", params: { p: 1 } }));
    await settle();
    expect(screen.getByTestId("params").textContent).toBe('{"p":1}');

    act(() => removePluginSlotRegistrations("alpha"));
    await settle();

    expect(screen.queryByTestId("body")).toBeNull();
    expect(modalToken()).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });
});

describe("modal validation", () => {
  it.each([
    ["undefined value", { a: undefined }],
    ["function", { a: () => 1 }],
    ["bigint", { a: BigInt(1) }],
    ["Date", { a: new Date() }],
    ["NaN", { a: Number.NaN }],
    ["DOM node", { a: document.createElement("div") }],
  ])("throws for %s before any history call", async (_name, params) => {
    render(<Harness />);
    const length = window.history.length;
    expect(() =>
      openCoreModal("core/test", {
        title: "A",
        params: params as never,
      }),
    ).toThrow(/experimental_modal/);
    expect(window.history.length).toBe(length);
  });

  it("throws for a cycle, an over-long title and an oversize state", async () => {
    render(<Harness />);
    const length = window.history.length;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() =>
      openCoreModal("core/test", { title: "A", params: cycle as never }),
    ).toThrow(/cycle/);
    expect(() =>
      openCoreModal("core/test", { title: "x".repeat(201) }),
    ).toThrow(/title/);
    expect(() =>
      openCoreModal("core/test", {
        title: "A",
        params: { big: "x".repeat(17 * 1024) },
      }),
    ).toThrow(/byte limit/);
    expect(window.history.length).toBe(length);
  });

  it("rejects a core id without the reserved prefix and a duplicate", () => {
    expect(() => registerCoreModal("test", Body)).toThrow(/core\//);
    expect(() => registerCoreModal("core/test", Body)).toThrow(/already/);
  });
});

describe("plugin handle", () => {
  it("reports the open id only to the owning plugin and updates on close", async () => {
    const handle = registerPlugin();
    const seen: Array<string | null> = [];
    function Watcher() {
      const id = handle.useOpenId();
      seen.push(id);
      return <span data-testid="open-id">{id ?? "none"}</span>;
    }
    render(
      <BrowserRouter>
        <Watcher />
        <ModalHost />
      </BrowserRouter>,
    );
    expect(screen.getByTestId("open-id").textContent).toBe("none");

    act(() => handle.open("settings", { title: "P" }));
    await settle();
    expect(screen.getByTestId("open-id").textContent).toBe("settings");

    act(() => handle.close());
    await settle();
    expect(screen.getByTestId("open-id").textContent).toBe("none");
  });

  it("does not re-render a subscriber on a navigation that changes no modal", async () => {
    const handle = registerPlugin();
    let renders = 0;
    function Watcher() {
      handle.useOpenId();
      renders += 1;
      return null;
    }
    render(
      <BrowserRouter>
        <Page />
        <Watcher />
        <ModalHost />
      </BrowserRouter>,
    );
    const before = renders;

    act(() => navigateTo("/a"));
    act(() => navigateTo("/b"));
    await settle();

    expect(renders).toBe(before);
  });
});

describe("crash isolation", () => {
  it("shows the error block, retries, and keeps the header close available", async () => {
    let crash = true;
    function Crashy() {
      if (crash) throw new Error("boom");
      return <span data-testid="recovered">ok</span>;
    }
    registerCoreModal("core/crashy", Crashy);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);

    act(() => openCoreModal("core/crashy", { title: "C" }));
    await settle();
    expect(screen.getByText("This view could not load.")).toBeTruthy();
    expect(screen.getByLabelText("Close")).toBeTruthy();

    crash = false;
    fireEvent.click(screen.getByText("Try again"));
    await settle();
    expect(screen.getByTestId("recovered")).toBeTruthy();
    error.mockRestore();
  });
});
