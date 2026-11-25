import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openPinnedGuest } from "../../../apps/host-daemon/src/managed-guest/journal.js";
import { ingress, observeProcess } from "./managed-guest-fixture.js";
const { root, pin, frame, point } = JSON.parse(readFileSync(0, "utf8"));
const kill = () => process.kill(process.pid, "SIGKILL");
const result = await openPinnedGuest(root, pin, ingress, {
  inspectEmpty: () => ({ physicalFence: 4 }),
  createSyntheticSession() {
    if (point === "before") kill();
    const providerThreadId = randomUUID();
    appendFileSync(join(root, "count"), providerThreadId + "\n");
    if (point === "after-create") kill();
    return { ...observeProcess(process.pid), providerThreadId };
  },
});
if (result.kind !== "protected") throw Error("Protected fixture required");
if ((await result.journal.receive(frame)) !== "applied")
  throw Error("Create failed");
kill(); // No return to the caller after the durable acceptance.
