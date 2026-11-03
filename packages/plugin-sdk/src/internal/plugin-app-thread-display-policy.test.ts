import { describe, expect, it } from "vitest";
import { collectPluginAppRegistrations } from "./plugin-app-collector.js";

describe("experimental_threadDisplayPolicy", () => {
  it("collects resolvers in registration order", () => {
    const first = () => ({ backgroundTurns: "collapsed" as const });
    const second = () => null;
    const captured = collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        app.experimental_threadDisplayPolicy(first);
        app.experimental_threadDisplayPolicy(second);
      },
    });
    expect(captured.threadDisplayPolicies).toEqual([first, second]);
  });

  it("defaults to no resolvers and rejects a non-function", () => {
    expect(
      collectPluginAppRegistrations({ __bbPluginApp: true, setup() {} })
        .threadDisplayPolicies,
    ).toEqual([]);
    expect(() =>
      collectPluginAppRegistrations({
        __bbPluginApp: true,
        setup(app) {
          app.experimental_threadDisplayPolicy("nope" as unknown as () => null);
        },
      }),
    ).toThrow();
  });
});
