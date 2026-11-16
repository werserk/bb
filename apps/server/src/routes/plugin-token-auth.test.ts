import { describe, expect, it } from "vitest";
import { validPluginToken } from "./plugin-token-auth.js";

describe("plugin token authentication", () => {
  it.each([
    [{ authorization: "Bearer secret" }, [], true],
    [{ "x-bb-plugin-token": "secret" }, [], true],
    [{}, ["secret"], true],
    [
      { authorization: "Bearer secret", "x-bb-plugin-token": "secret" },
      ["secret"],
      true,
    ],
    [
      { authorization: "Bearer secret", "x-bb-plugin-token": "wrong" },
      [],
      false,
    ],
    [{ authorization: "Bearer secret" }, ["wrong"], false],
    [{ authorization: "Bearer secret, Bearer secret" }, [], false],
    [{ authorization: "Basic secret" }, [], false],
    [{ authorization: "Bearer " }, [], false],
    [{}, ["secret", "secret"], false],
    [{}, [], false],
  ] as const)(
    "validates every supplied credential",
    (headers, query, expected) => {
      expect(validPluginToken(new Headers(headers), [...query], "secret")).toBe(
        expected,
      );
    },
  );
  it("rejects a missing configured token", () => {
    expect(
      validPluginToken(
        new Headers({ authorization: "Bearer secret" }),
        [],
        undefined,
      ),
    ).toBe(false);
  });
});
