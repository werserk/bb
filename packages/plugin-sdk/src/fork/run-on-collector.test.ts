import { describe, expect, it } from "vitest";
import { collectPluginAppRegistrations } from "../internal/plugin-app-collector.js";

const useChoices = () => ({ status: "ready" as const, choices: [] });
const useThreadWorkspace = () => null;
const Item = () => null;

function runOn(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    environmentProviderId: "account-workers-worker",
    title: "Workers",
    useChoices,
    useThreadWorkspace,
    ...overrides,
  };
}

function collect(
  register: (slots: Record<string, (value: unknown) => void>) => void,
) {
  const warnings: string[] = [];
  const captured = collectPluginAppRegistrations(
    {
      __bbPluginApp: true,
      setup(app) {
        register(
          app.slots as unknown as Record<string, (value: unknown) => void>,
        );
      },
    },
    (message) => warnings.push(message),
  );
  return { captured, warnings };
}

describe("experimental_runOnProvider registration", () => {
  it("collects a valid registration with its optional fields", () => {
    const { captured, warnings } = collect((slots) => {
      slots.experimental_runOnProvider(
        runOn({ description: "Agent on a worker", order: 2 }),
      );
    });
    expect(warnings).toEqual([]);
    expect(captured.runOnProviders).toEqual([
      {
        version: 1,
        environmentProviderId: "account-workers-worker",
        title: "Workers",
        description: "Agent on a worker",
        order: 2,
        useChoices,
        useThreadWorkspace,
      },
    ]);
  });

  it("skips an unknown version with one warning and keeps the rest of the app", () => {
    const { captured, warnings } = collect((slots) => {
      slots.experimental_runOnProvider(runOn({ version: 2 }));
      slots.experimental_composerRunRowItem({
        version: 1,
        id: "account",
        component: Item,
      });
    });
    expect(captured.runOnProviders).toEqual([]);
    expect(captured.composerRunRowItems).toHaveLength(1);
    expect(warnings).toEqual([
      "slots.experimental_runOnProvider: version 2 is not supported by this bb (supports 1); skipped",
    ]);
  });

  it("rejects a duplicate provider and invalid fields", () => {
    expect(() =>
      collect((slots) => {
        slots.experimental_runOnProvider(runOn());
        slots.experimental_runOnProvider(runOn());
      }),
    ).toThrow(/experimental_runOnProvider.*duplicate/i);
    for (const bad of [
      { title: "" },
      { useChoices: "nope" },
      { useThreadWorkspace: undefined },
      { order: Number.NaN },
      { ThreadActions: "nope" },
      { environmentProviderId: "" },
    ]) {
      expect(() =>
        collect((slots) => slots.experimental_runOnProvider(runOn(bad))),
      ).toThrow(/experimental_runOnProvider/);
    }
  });
});

describe("experimental_composerRunRowItem registration", () => {
  it("collects items and skips an unknown version", () => {
    const { captured, warnings } = collect((slots) => {
      slots.experimental_composerRunRowItem({
        version: 1,
        id: "account",
        order: 1,
        component: Item,
      });
      slots.experimental_composerRunRowItem({
        version: 3,
        id: "later",
        component: Item,
      });
    });
    expect(captured.composerRunRowItems).toEqual([
      { version: 1, id: "account", order: 1, component: Item },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("rejects a duplicate id and a missing component", () => {
    expect(() =>
      collect((slots) => {
        slots.experimental_composerRunRowItem({
          version: 1,
          id: "account",
          component: Item,
        });
        slots.experimental_composerRunRowItem({
          version: 1,
          id: "account",
          component: Item,
        });
      }),
    ).toThrow(/experimental_composerRunRowItem.*duplicate/i);
    expect(() =>
      collect((slots) =>
        slots.experimental_composerRunRowItem({ version: 1, id: "account" }),
      ),
    ).toThrow(/experimental_composerRunRowItem/);
  });
});
