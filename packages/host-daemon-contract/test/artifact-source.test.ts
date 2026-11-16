import { expect, it } from "vitest";
import { hostDaemonOnlineRpcCommandSchema } from "../src/commands.js";
it("requires paired strict root expectation on metadata and chunks while native stays unchanged", () => {
  for (const length of [0, 10]) {
    const native = {
      type: "host.read_file_chunk",
      rootPath: "/source",
      path: "/source/report.md",
      offset: 0,
      length,
      revision: null,
    };
    expect(hostDaemonOnlineRpcCommandSchema.parse(native)).toEqual(native);
    const strict = {
      ...native,
      artifactPolicy: "artifact-v1",
      expectedCanonicalRoot: "/source",
    };
    expect(hostDaemonOnlineRpcCommandSchema.parse(strict)).toEqual(strict);
    for (const invalid of [
      { ...native, artifactPolicy: "artifact-v1" },
      { ...native, expectedCanonicalRoot: "/source" },
      { ...strict, expectedCanonicalRoot: "relative" },
    ])
      expect(hostDaemonOnlineRpcCommandSchema.safeParse(invalid).success).toBe(
        false,
      );
  }
});
