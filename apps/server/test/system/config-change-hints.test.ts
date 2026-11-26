import { environmentVariables, projects } from "@bb/db";
import { defaultAppSettings } from "@bb/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function captureConfigHints(harness: TestAppHarness) {
  let hints = 0;
  harness.hub.onChangedMessage((message) => {
    if (
      message.entity === "system" &&
      message.changes.includes("config-changed")
    ) {
      hints += 1;
    }
  });
  const markAllStale = vi.spyOn(
    harness.deps.lifecycleDedupers.providerModelCatalogs,
    "markAllStale",
  );
  return {
    hints: () => hints,
    staleMarks: () => markAllStale.mock.calls.length,
    reset() {
      hints = 0;
      markAllStale.mockClear();
    },
  };
}

function send(
  harness: TestAppHarness,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
) {
  return harness.app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GLOBAL_ENV = "/api/v1/settings/machine-environment";
const GLOBAL_ENV_VARIABLE = GLOBAL_ENV;

describe("config-changed hints", () => {
  it("Same value written: an identical machine-env set, general-settings put and appearance put send no hint and mark nothing stale", async () => {
    await withTestHarness(async (harness) => {
      const variable = { name: "REGION", value: "fake-region", note: null };
      expect(
        (await send(harness, "POST", GLOBAL_ENV_VARIABLE, variable)).status,
      ).toBe(200);
      const appearance = { themeId: "nord", faviconColor: "default" };
      expect(
        (await send(harness, "PUT", "/api/v1/settings/appearance", appearance))
          .status,
      ).toBe(200);
      const general = { ...defaultAppSettings, earlyAdopter: true };
      expect(
        (await send(harness, "PUT", "/api/v1/settings/general", general))
          .status,
      ).toBe(200);
      const signals = captureConfigHints(harness);

      expect(
        (await send(harness, "POST", GLOBAL_ENV_VARIABLE, variable)).status,
      ).toBe(200);
      expect(
        (await send(harness, "PUT", GLOBAL_ENV, { variables: [variable] }))
          .status,
      ).toBe(200);
      expect(
        (await send(harness, "PUT", "/api/v1/settings/general", general))
          .status,
      ).toBe(200);
      expect(
        (await send(harness, "PUT", "/api/v1/settings/appearance", appearance))
          .status,
      ).toBe(200);

      expect(signals.hints()).toBe(0);
      expect(signals.staleMarks()).toBe(0);
    });
  });

  it("Real change: a changed setting value sends exactly one hint", async () => {
    await withTestHarness(async (harness) => {
      const signals = captureConfigHints(harness);
      expect(
        (
          await send(harness, "PUT", "/api/v1/settings/appearance", {
            themeId: "nord",
            faviconColor: "teal",
          })
        ).status,
      ).toBe(200);
      expect(signals.hints()).toBe(1);
      expect(signals.staleMarks()).toBe(0);
    });
  });

  it("Same name, new value: sends one hint and marks catalogs stale", async () => {
    await withTestHarness(async (harness) => {
      await send(harness, "POST", GLOBAL_ENV_VARIABLE, {
        name: "TOKEN",
        value: "fake-one",
        note: null,
      });
      const signals = captureConfigHints(harness);
      expect(
        (
          await send(harness, "POST", GLOBAL_ENV_VARIABLE, {
            name: "TOKEN",
            value: "fake-two",
            note: null,
          })
        ).status,
      ).toBe(200);
      expect(signals.hints()).toBe(1);
      expect(signals.staleMarks()).toBe(1);

      signals.reset();
      expect(
        (await send(harness, "DELETE", GLOBAL_ENV_VARIABLE, { name: "NONE" }))
          .status,
      ).toBe(200);
      expect(signals.hints()).toBe(0);
      expect(signals.staleMarks()).toBe(0);
    });
  });

  it("Undecryptable row: set and delete still succeed and emit", async () => {
    await withTestHarness(async (harness) => {
      const corrupt = () => {
        const row = harness.db
          .select()
          .from(environmentVariables)
          .where(eq(environmentVariables.name, "TOKEN"))
          .get();
        const bytes = Buffer.from(row?.ciphertext ?? "", "base64");
        bytes[28] = bytes[28]! ^ 1;
        harness.db
          .update(environmentVariables)
          .set({ ciphertext: bytes.toString("base64") })
          .where(eq(environmentVariables.name, "TOKEN"))
          .run();
      };
      const token = { name: "TOKEN", value: "fake-token", note: null };
      await send(harness, "POST", GLOBAL_ENV_VARIABLE, token);
      corrupt();
      const signals = captureConfigHints(harness);
      expect(
        (await send(harness, "POST", GLOBAL_ENV_VARIABLE, token)).status,
      ).toBe(200);
      expect(signals.hints()).toBe(1);

      corrupt();
      signals.reset();
      expect(
        (await send(harness, "DELETE", GLOBAL_ENV_VARIABLE, { name: "TOKEN" }))
          .status,
      ).toBe(200);
      expect(signals.hints()).toBe(1);
      expect(signals.staleMarks()).toBe(1);
    });
  });

  it("Same name, new value in a project: sends one hint", async () => {
    await withTestHarness(async (harness) => {
      harness.db
        .insert(projects)
        .values({ id: "project-a", name: "A", createdAt: 1, updatedAt: 1 })
        .run();
      const path = "/api/v1/projects/project-a/machine-environment";
      await send(harness, "POST", path, {
        name: "TOKEN",
        value: "fake-one",
        note: null,
      });
      const signals = captureConfigHints(harness);
      expect(
        (
          await send(harness, "POST", path, {
            name: "TOKEN",
            value: "fake-one",
            note: null,
          })
        ).status,
      ).toBe(200);
      expect(signals.hints()).toBe(0);
      expect(
        (
          await send(harness, "POST", path, {
            name: "TOKEN",
            value: "fake-two",
            note: null,
          })
        ).status,
      ).toBe(200);
      expect(signals.hints()).toBe(1);
      expect(signals.staleMarks()).toBe(0);
    });
  });
});
