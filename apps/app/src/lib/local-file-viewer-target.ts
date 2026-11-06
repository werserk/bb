import { z } from "zod";
import { isRawThreadId } from "@bb/domain";
import type { EmbeddedLocalFileTarget } from "./embedded-local-file-target";

export type LocalFileViewerTarget = Extract<
  EmbeddedLocalFileTarget,
  { kind: "thread-storage" | "workspace" }
>;

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !/^(?:[\\/]|[a-z]:)/iu.test(path) &&
      !path
        .split(/[\\/]/u)
        .some((segment) => segment === ".." || segment === "."),
  );
const fields = {
  path: z
    .string()
    .min(1)
    .refine((path) => !path.includes("\0")),
  relativePath,
  lineRange: z
    .object({
      startLineNumber: z.number().int().positive(),
      endLineNumber: z.number().int().positive(),
    })
    .refine((range) => range.endLineNumber >= range.startLineNumber)
    .nullable(),
};
const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    ...fields,
    kind: z.literal("thread-storage"),
    threadId: z.string().refine(isRawThreadId),
  }),
  z.object({
    ...fields,
    kind: z.literal("workspace"),
    environmentId: z.string().min(1),
  }),
]);

export function parseLocalFileViewerTarget(
  value: unknown,
): LocalFileViewerTarget | null {
  const result = targetSchema.safeParse(value);
  return result.success ? result.data : null;
}

interface EnvironmentThreads {
  complete: boolean;
  threads: readonly {
    id: string;
    environmentId: string | null;
    archived: boolean;
  }[];
}

export function resolveHomeThread(
  value: unknown,
  membership?: EnvironmentThreads,
): string | null {
  const target = parseLocalFileViewerTarget(value);
  if (target === null) return null;
  if (target.kind === "thread-storage") return target.threadId;
  if (!membership?.complete) return null;
  const threads = membership.threads.filter(
    (thread) =>
      !thread.archived && thread.environmentId === target.environmentId,
  );
  return threads.length === 1 && isRawThreadId(threads[0]!.id)
    ? threads[0]!.id
    : null;
}
