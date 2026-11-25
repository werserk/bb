import { describe, expect, it } from "vitest";
import {
  canonicalWorkspaceBytes,
  workspaceBindingRef,
  workspaceBindingSchema,
} from "../src/workspace-binding.js";
const binding = {
  schemaVersion: 1,
  workspaceBindingId: "ws",
  revision: 1,
  hostId: "host",
  environmentId: "env",
  projectId: null,
  sourceId: null,
  pathFlavor: "posix",
  canonicalRoot: "/scratch",
  adapter: { id: "bb-mcp-workspace", version: "1" },
  requiredCapabilities: ["text.write", "text.read"],
};
describe("Workspace binding v1", () => {
  it("matches the reviewed canonical ASCII recipe across serialization", () => {
    const canonical =
      '{"adapter":{"id":"bb-mcp-workspace","version":"1"},"canonicalRoot":"/scratch","environmentId":"env","hostId":"host","pathFlavor":"posix","projectId":null,"requiredCapabilities":["text.read","text.write"],"revision":1,"schemaVersion":1,"sourceId":null,"workspaceBindingId":"ws"}';
    expect(canonicalWorkspaceBytes(binding)).toBe(canonical);
    expect(workspaceBindingRef(binding).workspaceDigest).toBe(
      "sha256:738f085fda503e83ef3759288f97ffdd139fc3aa26f5b11952245c1ea569c71f",
    );
    expect(
      workspaceBindingRef(
        JSON.parse(
          JSON.stringify({
            ...binding,
            requiredCapabilities: ["text.read", "text.write"],
          }),
        ),
      ),
    ).toEqual(workspaceBindingRef(binding));
  });
  it.each([
    { canonicalRoot: "/a/../b" },
    { canonicalRoot: "/a/" },
    { hostId: "\ud800" },
    { revision: 0 },
    { requiredCapabilities: ["text.read", "text.read"] },
    { extra: true },
  ])("rejects malformed closed identity %j", (patch) => {
    expect(
      workspaceBindingSchema.safeParse({ ...binding, ...patch }).success,
    ).toBe(false);
  });
});
