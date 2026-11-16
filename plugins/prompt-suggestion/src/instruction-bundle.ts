import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  DEFAULT_INSTRUCTIONS,
  LEGACY_INSTRUCTIONS,
  OUTPUT_CONTRACT,
} from "./instructions.js";

export function instructionBundle(bb: BbPluginApi, guidance: string) {
  const owner = bb.experimental_userInstructions?.read();
  if (!owner || owner.kind !== "ready") return null;
  return composeInstructionBundle(owner, guidance);
}

export function composeInstructionBundle(
  owner: { content: string; revision: string },
  guidance: string,
) {
  const additional =
    guidance === LEGACY_INSTRUCTIONS || guidance === DEFAULT_INSTRUCTIONS
      ? ""
      : guidance.trim();
  const content = [
    DEFAULT_INSTRUCTIONS,
    OUTPUT_CONTRACT,
    "The following owner base instructions apply within your recommendation-only role. No tools or other execution capabilities are available.",
    "<owner_instructions>",
    owner.content,
    "</owner_instructions>",
    ...(additional
      ? ["<additional_guidance>", additional, "</additional_guidance>"]
      : []),
  ].join("\n\n");
  return {
    content,
    revision: createHash("sha256").update(content).digest("hex"),
    ownerRevision: owner.revision,
  };
}
