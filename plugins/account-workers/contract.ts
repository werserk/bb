import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BINDING_ID } from "./ids.js";
import { PROFILE_ID } from "./profiles/types.js";

function outcome<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), ...shape }).strict(),
    z.object({ ok: z.literal(false), error: z.string() }).strict(),
  ]);
}

const root = z.string().min(1);
const relPath = z.string().min(1).max(4096);
const bindingId = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const profileId = z.string().regex(PROFILE_ID);
const mintedBindingId = z.string().regex(BINDING_ID);

export const instructionFileSchema = z
  .object({ file: z.string(), text: z.string(), truncated: z.boolean() })
  .strict();
export type InstructionFile = z.infer<typeof instructionFileSchema>;

export const accountWorkersHostContract = defineRpcContract({
  resolveRoot: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: outcome({
      root: z.string(),
      hostname: z.string(),
      instructions: z.array(instructionFileSchema),
      branch: z.string().nullable(),
    }),
    experimental_retryable: true,
  },
  prepareScratch: {
    input: z
      .object({
        bindingId,
        profile: profileId,
        providerId: z.string().min(1).max(128),
        model: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    output: outcome({ path: z.string() }),
  },
  releaseScratch: {
    input: z
      .object({
        bindingId: mintedBindingId,
        profile: profileId,
        scratchPath: z.string().min(1).max(4096).optional(),
      })
      .strict(),
    output: outcome({}),
  },
  verifyProfile: {
    input: z
      .object({
        bindingId,
        profile: profileId,
        toolName: z.string().regex(/^[a-z_]{1,64}$/),
        input: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: outcome({}),
  },
  read: {
    input: z
      .object({
        root,
        path: relPath,
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).optional(),
      })
      .strict(),
    output: outcome({
      text: z.string(),
      sha256: z.string(),
      totalLines: z.number().int(),
      truncated: z.boolean(),
    }),
    experimental_retryable: true,
  },
  write: {
    input: z
      .object({
        root,
        path: relPath,
        content: z.string(),
        expectedSha256: z.string().optional(),
      })
      .strict(),
    output: outcome({
      sha256: z.string(),
      bytes: z.number().int(),
      created: z.boolean(),
      diff: z.string(),
    }),
  },
  edit: {
    input: z
      .object({
        root,
        path: relPath,
        oldString: z.string().min(1),
        newString: z.string(),
        replaceAll: z.boolean(),
        expectedSha256: z.string().optional(),
      })
      .strict(),
    output: outcome({ sha256: z.string(), replacements: z.number().int(), diff: z.string() }),
  },
  glob: {
    input: z
      .object({ root, pattern: z.string().min(1), path: relPath.optional() })
      .strict(),
    output: outcome({ files: z.array(z.string()), truncated: z.boolean() }),
    experimental_retryable: true,
  },
  grep: {
    input: z
      .object({
        root,
        pattern: z.string().min(1),
        path: relPath.optional(),
        glob: z.string().optional(),
        ignoreCase: z.boolean(),
      })
      .strict(),
    output: outcome({ output: z.string(), truncated: z.boolean() }),
    experimental_retryable: true,
  },
  exec: {
    input: z
      .object({
        root,
        command: z.string().min(1),
        cwd: relPath.optional(),
        timeoutMs: z.number().int().min(1),
      })
      .strict(),
    output: outcome({
      output: z.string(),
      truncated: z.boolean(),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      cancelled: z.boolean(),
      hostname: z.string(),
      durationMs: z.number().int(),
    }),
  },
  diff: {
    input: z.object({ root }).strict(),
    output: outcome({ output: z.string(), truncated: z.boolean() }),
    experimental_retryable: true,
  },
});
