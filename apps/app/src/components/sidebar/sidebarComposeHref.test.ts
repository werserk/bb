import { describe, expect, it } from "vitest";
import {
  buildSidebarComposeHref,
  readSidebarComposeTarget,
} from "./sidebarComposeHref";

describe("sidebar composer tab context", () => {
  it("round trips project and environment IDs through a new browser tab URL", () => {
    const href = buildSidebarComposeHref("project & one", "env/two");
    expect(
      readSidebarComposeTarget(new URL(href, "https://bb.test").search),
    ).toEqual({
      projectId: "project & one",
      reuseEnvironmentId: "env/two",
    });
  });
  it("keeps a fresh environment absent and ignores unrelated search parameters", () => {
    expect(readSidebarComposeTarget("?initialPrompt=hello")).toBeNull();
    expect(readSidebarComposeTarget("?projectId=personal")).toEqual({
      projectId: "personal",
      reuseEnvironmentId: null,
    });
  });
});
