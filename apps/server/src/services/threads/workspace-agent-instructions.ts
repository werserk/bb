import fs from "node:fs";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import path from "node:path";
import type { ServerLogger } from "../../types.js";
import { isFsErrorWithCode } from "../lib/fs-errors.js";

export const DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH = "AGENTS.md";

export const WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH = ".bb/AGENTS.md";

export function readOwnerInstructions(
  logger: ServerLogger,
  dataDir: string,
): ReturnType<BbPluginApi["experimental_userInstructions"]["read"]> {
  const filePath = path.join(
    dataDir,
    DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH,
  );
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      return { kind: "unavailable", reason: "missing" };
    }
    logger.warn(
      {
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Skipping unreadable agent instructions file",
    );
    return { kind: "unavailable", reason: "unreadable" };
  }

  return content.trim().length > 0
    ? {
        kind: "ready",
        content,
        revision: createHash("sha256").update(content).digest("hex"),
      }
    : { kind: "unavailable", reason: "empty" };
}

export function readDataDirAgentInstructions(
  logger: ServerLogger,
  dataDir: string,
): string | null {
  const result = readOwnerInstructions(logger, dataDir);
  return result.kind === "ready" ? result.content.trim() : null;
}
