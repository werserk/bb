import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPinnedGuest } from "../../../apps/host-daemon/src/managed-guest/journal.js";
import { frame, ingress, observeProcess } from "./managed-guest-fixture.js";

// Private test controller supplies its launch pin on stdin, never via a host RPC.
const { root, pin, command, after } = JSON.parse(readFileSync(0, "utf8"));
const receiver = await openPinnedGuest(root, pin, ingress, {
  async inspect() {},
  observe: () => observeProcess(process.pid),
  countInput() {
    if (after) appendFileSync(join(root, "effects"), "input\n");
    process.kill(process.pid, "SIGKILL");
  },
  interrupt() {
    throw new Error("Unexpected interrupt");
  },
});
if (receiver.kind !== "protected")
  throw new Error("Protected fixture required");
await receiver.journal.receive(frame(command));
throw new Error("Crash hook did not terminate this fixture");
