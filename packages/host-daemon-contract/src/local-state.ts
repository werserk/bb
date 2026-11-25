import { placementBindingSchema } from "@bb/domain";
import { z } from "zod";

export const HOST_AUTH_FILE_NAME = "auth.json";
export const HOST_ID_FILE_NAME = "host-id";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.href.replace(/\/$/u, "");
}

const currentHostAuthStateSchema = z
  .object({
    hostId: z.string().min(1),
    hostKey: nonEmptyTrimmedStringSchema,
  })
  .strict();

// Only an independently pinned local test supervisor may run this profile.
export const managedGuestEnrollmentSchema = z.strictObject({
  profile: z.literal("synthetic-only-v1"),
  binding: placementBindingSchema,
  uid: z.number().int().nonnegative(),
  runtimeRootKey: nonEmptyTrimmedStringSchema,
  launchProfileId: nonEmptyTrimmedStringSchema,
  journalId: z.uuid(),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export type ManagedGuestEnrollment = z.infer<
  typeof managedGuestEnrollmentSchema
>;
const protectedHostAuthStateSchema = currentHostAuthStateSchema
  .extend({ managedGuest: managedGuestEnrollmentSchema })
  .strict();

const legacyHostAuthStateSchema = z
  .object({
    hostId: z.string().min(1),
    hostKey: nonEmptyTrimmedStringSchema,
    hostType: z.literal("persistent").optional(),
    serverUrl: z.unknown().optional(),
  })
  .strict()
  .transform(({ hostId, hostKey }) => ({ hostId, hostKey }));

export const hostAuthStateSchema = z.union([
  protectedHostAuthStateSchema,
  currentHostAuthStateSchema,
  legacyHostAuthStateSchema,
]);

export type HostAuthState = z.infer<typeof hostAuthStateSchema>;
