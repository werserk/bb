import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  readOwnerInstructions,
  readDataDirAgentInstructions,
} from "./workspace-agent-instructions.js";

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe("owner instruction source", () => {
  it("preserves bytes and hashes changes while the core keeps its trimmed composition", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-instructions-"));
    try {
      const content = "\n# BIBLE\nKeep the goal.\n\n";
      writeFileSync(join(dir, "AGENTS.md"), content);
      const first = readOwnerInstructions(logger, dir);
      expect(first).toMatchObject({ kind: "ready", content });
      expect(readDataDirAgentInstructions(logger, dir)).toBe(content.trim());
      writeFileSync(join(dir, "AGENTS.md"), content.replace("goal", "task"));
      const second = readOwnerInstructions(logger, dir);
      expect(second.kind).toBe("ready");
      if (first.kind === "ready" && second.kind === "ready")
        expect(second.revision).not.toBe(first.revision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("distinguishes missing, empty and unreadable without changing core absence behavior", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-instructions-"));
    try {
      expect(readOwnerInstructions(logger, dir)).toEqual({
        kind: "unavailable",
        reason: "missing",
      });
      writeFileSync(join(dir, "AGENTS.md"), " \n");
      expect(readOwnerInstructions(logger, dir)).toEqual({
        kind: "unavailable",
        reason: "empty",
      });
      rmSync(join(dir, "AGENTS.md"));
      mkdirSync(join(dir, "AGENTS.md"));
      expect(readOwnerInstructions(logger, dir)).toEqual({
        kind: "unavailable",
        reason: "unreadable",
      });
      expect(readDataDirAgentInstructions(logger, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
