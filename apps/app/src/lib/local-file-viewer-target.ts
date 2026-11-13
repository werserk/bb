import { normalizeExperimentalFileOpenOptions } from "@/lib/live-file-navigation";
import { z } from "zod";
import { isRawThreadId } from "@bb/domain";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !/^(?:[\\/]|[a-z]:[\\/])/iu.test(path) &&
      !path
        .split(/[\\/]/u)
        .some((segment) => segment === ".." || segment === "."),
  );
const fields = {
  experimental_artifact: z
    .object({ version: z.literal(1), readRoot: z.string() })
    .strict()
    .optional(),
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
    relativePath: fields.path,
    kind: z.literal("host"),
    hostId: z.string().min(1),
  }),
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

export type LocalFileViewerTarget = z.infer<typeof targetSchema>;

export function parseLocalFileViewerTarget(
  value: unknown,
): LocalFileViewerTarget | null {
  const result = targetSchema.safeParse(value);
  if (!result.success) return null;
  const target = result.data;
  if (target.kind === "host" && normalizeExperimentalFileOpenOptions({ target: { kind: "host", hostId: target.hostId, path: target.path }, location: null }) === null) return null;
  if (target.experimental_artifact) {
    const file =
      target.kind === "workspace"
        ? {
            kind: target.kind,
            environmentId: target.environmentId,
            path: target.relativePath,
          }
        : target.kind === "host"
          ? { kind: target.kind, hostId: target.hostId, path: target.path }
          : {
              kind: target.kind,
              threadId: target.threadId,
              path: target.relativePath,
            };
    if (
      normalizeExperimentalFileOpenOptions({
        target: file,
        location: null,
        experimental_artifact: target.experimental_artifact,
      }) === null
    )
      return null;
  }
  return target;
}

export function resolveHomeThread(value: unknown): string | null {
  const target = parseLocalFileViewerTarget(value);
  return target?.kind === "thread-storage" ? target.threadId : null;
}
