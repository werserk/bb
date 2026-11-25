import { fixtureAuthority } from "./placement.js";
import { createConnection } from "../../src/connection.js";
import { acceptPlacementOperation } from "../../src/data/placement-operations.js";
import { reservePlacementWorker } from "../../src/data/placement-admission.js";
import { readPlacementWorker } from "../../src/data/placement-workers.js";
import { candidate } from "./placement.js";
const db = createConnection(process.argv[2]);
process.send?.("ready");
process.once("message", () => {
  try {
    const result =
      process.argv[3] === "accept"
        ? acceptPlacementOperation(db, {
            authority: fixtureAuthority,
            principalScope: "owner",
            submissionKey: "process-key",
            ownerPluginId: "workers",
            providerId: "claude",
            request: {
              schemaVersion: 1,
              intent: {
                kind: "independent",
                selection: { mode: "auto" },
                request: { input: "same bytes" },
              },
            },
          })
        : reservePlacementWorker(db, {
            ...candidate(db, process.argv[4]!),
            workerId: process.argv[5] ?? "worker",
            workerRevision: readPlacementWorker(
              db,
              "workers",
              process.argv[5] ?? "worker",
            )!.observationRevision,
          });
    process.send?.(result);
  } finally {
    db.$client.close();
    process.disconnect();
  }
});
