import { canonicalJsonBytes, sha256Digest } from "@bb/domain";
import {
  HOST_ID_FILE_NAME,
  type ManagedGuestEnrollment,
} from "@bb/host-daemon-contract";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readHostAuthState } from "../auth-state.js";

// Supplied exclusively at local supervisor construction, outside mutable daemon data.
// The experimental receiver has no default pin and accepts no remote enrollment input.
export interface LocalEnrollmentPin {
  hostId: string;
  descriptorDigest: string;
}
export function enrollmentDigest(
  hostId: string,
  managedGuest: ManagedGuestEnrollment | null,
): string {
  return sha256Digest(canonicalJsonBytes({ hostId, managedGuest }));
}
export async function classifyPinnedEnrollment(
  dataDir: string,
  pin: LocalEnrollmentPin,
) {
  const auth = await readHostAuthState(dataDir);
  if (
    !auth ||
    !pin ||
    auth.hostId !== pin.hostId ||
    (await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")).trim() !==
      pin.hostId
  )
    throw new Error("Guest enrollment identity unavailable");
  const guest = "managedGuest" in auth ? auth.managedGuest : null;
  if (enrollmentDigest(auth.hostId, guest) !== pin.descriptorDigest)
    throw new Error("Guest enrollment does not match the supervisor pin");
  if (
    guest &&
    (guest.binding.agentHostId !== pin.hostId ||
      process.getuid?.() !== guest.uid)
  )
    throw new Error("Guest worker identity unavailable");
  return guest;
}
