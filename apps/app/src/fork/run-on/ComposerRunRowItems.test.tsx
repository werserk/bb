// @vitest-environment jsdom

import type {
  ExperimentalComposerRunRowItemProps,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginComposerRunRowItemSlot } from "@/lib/plugin-slots";
import { ComposerRunRowItems } from "./ComposerRunRowItems";

const stubs = vi.hoisted(() => ({
  items: [] as unknown[],
  props: new Map<string, unknown>(),
}));

vi.mock("@/lib/plugin-slots", () => ({
  usePluginSlotKind: () => stubs.items,
}));
vi.mock("@/components/plugin/PluginSlotMount", () => ({
  PluginSlotMount: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@bb/shared-ui/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));

function item(
  pluginId: string,
  id: string,
  order?: number,
): PluginComposerRunRowItemSlot {
  return {
    pluginId,
    generation: 1,
    version: 1,
    id,
    ...(order === undefined ? {} : { order }),
    component: (props: ExperimentalComposerRunRowItemProps) => {
      stubs.props.set(`${pluginId}:${id}`, props);
      return <span data-item={`${pluginId}:${id}`} />;
    },
  };
}

function propsOf(key: string): ExperimentalComposerRunRowItemProps {
  return stubs.props.get(key) as ExperimentalComposerRunRowItemProps;
}

afterEach(() => {
  cleanup();
  stubs.items = [];
  stubs.props.clear();
});

describe("ComposerRunRowItems", () => {
  it("orders items by order, then plugin id, then item id", () => {
    stubs.items = [
      item("pool", "account", 10),
      item("zeta", "b"),
      item("alpha", "a"),
      item("pool", "late", 20),
    ];
    const { container } = render(
      <ComposerRunRowItems
        scope={{ kind: "thread", threadId: "thr_1", projectId: "p" }}
      />,
    );
    expect(
      [...container.querySelectorAll("[data-item]")].map((node) =>
        node.getAttribute("data-item"),
      ),
    ).toEqual(["alpha:a", "zeta:b", "pool:account", "pool:late"]);
  });

  it("gives each plugin only its own held data and a detached setter", () => {
    stubs.items = [item("pool", "account", 10), item("other", "x")];
    const setSubmissionFor = vi.fn<
      (pluginId: string, data: JsonValue | null) => boolean
    >(() => true);
    render(
      <ComposerRunRowItems
        scope={{ kind: "new-thread", projectId: "p", providerId: "codex" }}
        submission={{ pluginId: "pool", data: { accountId: "a1" } }}
        setSubmissionFor={setSubmissionFor}
      />,
    );
    expect(propsOf("pool:account").submission).toEqual({ accountId: "a1" });
    expect(propsOf("other:x").submission).toBeNull();

    const { setSubmission } = propsOf("pool:account");
    expect(setSubmission?.(null)).toBe(true);
    expect(setSubmissionFor).toHaveBeenCalledWith("pool", null);
  });

  it("passes neither submission nor setter for an open thread", () => {
    stubs.items = [item("pool", "account", 10)];
    render(
      <ComposerRunRowItems
        scope={{ kind: "thread", threadId: "thr_1", projectId: "p" }}
      />,
    );
    expect(propsOf("pool:account")).not.toHaveProperty("submission");
    expect(propsOf("pool:account")).not.toHaveProperty("setSubmission");
  });
});
