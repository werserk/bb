import { describe, expect, it, vi } from "vitest";
import { prepareProviderProcessPriority } from "./provider-process-priority.js";

const request = {
  command: "/a path/node",
  args: ["bridge.mjs", "$HOME", "a;b", "", "--flag"],
  cwd: "/workspace",
  env: { PATH: "/usr/bin" },
};

function tools(missing: string[] = []) {
  return {
    platform: "linux" as NodeJS.Platform,
    resolve: (name: string) =>
      missing.includes(name) ? null : `/usr/bin/${name}`,
    run: vi.fn(async (_command: string, _args: string[]) => {}),
  };
}

describe("provider process priority", () => {
  it("leaves non-Linux launches untouched without probing systemd", async () => {
    const deps = { ...tools(), platform: "darwin" as const };
    expect(await prepareProviderProcessPriority(request, deps)).toEqual(
      request,
    );
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("sets the canonical slice weight before preparing one argv-preserving scope", async () => {
    const deps = tools();
    const result = await prepareProviderProcessPriority(request, deps);
    expect(deps.run.mock.calls).toEqual([
      [
        "/usr/bin/systemctl",
        ["--user", "show", "--property=Version", "--value"],
      ],
      [
        "/usr/bin/systemctl",
        [
          "--user",
          "set-property",
          "--runtime",
          "app-bbchecks.slice",
          "CPUWeight=1",
        ],
      ],
    ]);
    expect(result).toEqual({
      ...request,
      command: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--slice=app-bbchecks.slice",
        "--property=CPUWeight=1",
        "--expand-environment=no",
        "--",
        "/usr/bin/nice",
        "-n",
        "19",
        "/usr/bin/ionice",
        "-c",
        "3",
        "--",
        request.command,
        ...request.args,
      ],
    });
  });

  it.each(["systemd-run", "systemctl"])(
    "uses nice/ionice when %s is missing",
    async (name) => {
      const deps = tools([name]);
      const result = await prepareProviderProcessPriority(request, deps);
      expect(result.command).toBe("/usr/bin/nice");
      expect(result.args).toEqual([
        "-n",
        "19",
        "/usr/bin/ionice",
        "-c",
        "3",
        "--",
        request.command,
        ...request.args,
      ]);
      expect(deps.run).not.toHaveBeenCalled();
    },
  );

  it("falls back when the user manager probe fails, before launching any command", async () => {
    const deps = tools();
    deps.run.mockRejectedValueOnce(new Error("no user bus"));
    expect((await prepareProviderProcessPriority(request, deps)).command).toBe(
      "/usr/bin/nice",
    );
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("refuses a failed slice admission without launching or falling back", async () => {
    const deps = tools();
    deps.run
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    await expect(prepareProviderProcessPriority(request, deps)).rejects.toThrow(
      "denied",
    );
    expect(deps.run).toHaveBeenCalledTimes(2);
  });

  it.each(["nice", "ionice"])(
    "refuses to silently lose priority when %s is missing",
    async (name) => {
      const deps = tools([name]);
      await expect(
        prepareProviderProcessPriority(request, deps),
      ).rejects.toThrow(name);
      expect(deps.run).not.toHaveBeenCalled();
    },
  );
});
