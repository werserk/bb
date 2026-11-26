import { describe, expect, it } from "vitest";
import { codexAccessTokenExpiresAt } from "./credentials.js";

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex access token expiry", () => {
  it("reads exp in milliseconds", () => {
    expect(codexAccessTokenExpiresAt(token({ exp: 2_000_000_000 }))).toBe(
      2_000_000_000_000,
    );
  });

  it("returns null without a readable exp", () => {
    expect(codexAccessTokenExpiresAt(token({}))).toBeNull();
    expect(codexAccessTokenExpiresAt("not-a-jwt")).toBeNull();
  });
});
