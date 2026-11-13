import { execHostFile, hostToolchain } from "@bb/process-utils";

interface ProviderProcessLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface PriorityTools {
  platform: NodeJS.Platform;
  resolve(name: string): string | null;
  run(command: string, args: string[]): Promise<void>;
}

export async function prepareProviderProcessPriority(
  request: ProviderProcessLaunch,
  tools: PriorityTools = {
    platform: process.platform,
    resolve: (name) => hostToolchain.resolve(name, request),
    run: async (command, args) => {
      await execHostFile(command, args, {
        cwd: request.cwd,
        env: request.env,
        timeout: 5_000,
        maxBuffer: 16_384,
      });
    },
  },
): Promise<ProviderProcessLaunch> {
  if (tools.platform !== "linux") return request;
  const required = (name: string): string => {
    const executable = tools.resolve(name);
    if (executable === null) {
      throw new Error(
        `Required provider priority executable unavailable: ${name}`,
      );
    }
    return executable;
  };
  const nice = required("nice");
  const ionice = required("ionice");
  const fallback = {
    ...request,
    command: nice,
    args: [
      "-n",
      "19",
      ionice,
      "-c",
      "3",
      "--",
      request.command,
      ...request.args,
    ],
  };
  const systemdRun = tools.resolve("systemd-run");
  const systemctl = tools.resolve("systemctl");
  if (systemdRun === null || systemctl === null) return fallback;
  try {
    await tools.run(systemctl, [
      "--user",
      "show",
      "--property=Version",
      "--value",
    ]);
  } catch {
    return fallback;
  }
  await tools.run(systemctl, [
    "--user",
    "set-property",
    "--runtime",
    "app-bbchecks.slice",
    "CPUWeight=1",
  ]);
  return {
    ...request,
    command: systemdRun,
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--slice=app-bbchecks.slice",
      "--property=CPUWeight=1",
      "--expand-environment=no",
      "--",
      fallback.command,
      ...fallback.args,
    ],
  };
}
