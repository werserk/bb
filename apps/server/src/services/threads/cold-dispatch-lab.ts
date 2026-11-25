// Private 271 build only. A fixture registration is scoped to this server's DB.
import type { DbConnection } from "@bb/db";
import type { ClientTurnRequestId, WorkspacePurpose } from "@bb/domain";
export type ColdDispatchKey = {
  threadId: string;
  requestId: ClientTurnRequestId;
};
type FixturePurpose = Extract<WorkspacePurpose, { kind: "local-fixture" }>;
type Handler = (
  key: ColdDispatchKey,
  purpose: FixturePurpose,
) => Promise<"unsupported" | "recorded">;
const registrations = new WeakMap<
  DbConnection,
  { run: string; handle: Handler }
>();
export function registerColdDispatchLab(
  db: DbConnection,
  run: string,
  handle: Handler,
) {
  if (!run || registrations.has(db))
    throw Error("Unexpected cold fixture registration");
  registrations.set(db, { run, handle });
  return () => registrations.delete(db);
}
export function readColdDispatchLab(
  db: DbConnection,
  purpose: WorkspacePurpose | undefined,
) {
  const registration = registrations.get(db);
  if (
    !registration ||
    purpose?.kind !== "local-fixture" ||
    registration.run !== purpose.fixtureRunId
  )
    return null;
  return (key: ColdDispatchKey) => registration.handle(key, purpose);
}
