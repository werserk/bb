import { setOwnerMode } from "../../src/internal-placement-owner.js";
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
    if (process.argv[3] === "mode-race" && process.argv[4] === "disable") {
      process.send?.(
        setOwnerMode(db, {
          providerId: "claude",
          ownerPluginId: "workers",
          mode: "disabled",
          expectedRevision: 2,
          handoffReceiptId: null,
        }),
      );
      return;
    }
    const result =
      process.argv[3] === "accept" || process.argv[3] === "mode-race"
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
