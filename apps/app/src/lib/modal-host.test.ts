// @vitest-environment jsdom

import type { Location } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  isModalOnlyTransition,
  readModalFromLocationState,
  readModalFromState,
  stripModalFromLocationState,
} from "./modal-host";

const modal = {
  v: 1,
  token: "t1",
  kind: "plugin",
  pluginId: "alpha",
  modalId: "settings",
  title: "Settings",
  context: "Alpha",
  params: { section: "roles" },
};

function location(overrides: Partial<Location>): Location {
  return {
    pathname: "/chat",
    search: "",
    hash: "",
    state: null,
    key: "k",
    ...overrides,
  };
}

describe("modal state readers", () => {
  it("reads a well-formed modal from location state and history state", () => {
    expect(readModalFromLocationState({ bbModal: modal })?.modalId).toBe(
      "settings",
    );
    expect(readModalFromState({ usr: { bbModal: modal } })?.token).toBe("t1");
  });

  it.each([
    null,
    {},
    { bbModal: { ...modal, v: 2 } },
    { bbModal: { ...modal, token: 1 } },
    { bbModal: { ...modal, kind: "plugin", pluginId: undefined } },
    { bbModal: { ...modal, kind: "other" } },
    { bbModal: { ...modal, params: undefined } },
  ])("ignores a malformed state %#", (value) => {
    expect(readModalFromLocationState(value)).toBeNull();
  });

  it("strips only the modal key and keeps other state", () => {
    expect(stripModalFromLocationState({ bbModal: modal })).toBeNull();
    expect(stripModalFromLocationState({ bbModal: modal, keep: 1 })).toEqual({
      keep: 1,
    });
    expect(stripModalFromLocationState(undefined)).toBeNull();
  });
});

describe("isModalOnlyTransition", () => {
  const bare = location({});
  const open = location({ key: "m", state: { bbModal: modal } });

  it("is true when only the modal differs", () => {
    expect(isModalOnlyTransition(bare, open)).toBe(true);
    expect(isModalOnlyTransition(open, bare)).toBe(true);
    expect(
      isModalOnlyTransition(
        open,
        location({
          key: "n",
          state: { bbModal: { ...modal, token: "t2" } },
        }),
      ),
    ).toBe(true);
  });

  it("is false for a real route, search or hash change", () => {
    expect(isModalOnlyTransition(bare, location({ pathname: "/x" }))).toBe(
      false,
    );
    expect(isModalOnlyTransition(bare, location({ search: "?q=1" }))).toBe(
      false,
    );
    expect(isModalOnlyTransition(bare, location({ hash: "#a" }))).toBe(false);
  });

  it("is false for a new key with no modal on either side", () => {
    expect(isModalOnlyTransition(bare, location({ key: "z" }))).toBe(false);
  });
});
