import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { archiveThread, createConnection, getLatestThreadSequence, listEvents, resetPlacementOwnerAvailability } from "@bb/db";
import { encodeClientTurnRequestIdNumber, threadScope } from "@bb/domain";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { seedEvent } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";

it("reads retained membership beyond 1000 later requests after owner loss, respecting archive and scope", async () => {
  await withTestHarness(async h => {
    const f = seedManagedGroup(h);
    const entry = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
    try {
      const original = await (await f.send()).json();
      expect(original.details.state).toBe("refused_unsent");
      const threadId = f.threadId;
      const prior = listEvents(h.db, {threadId}).find(row => row.type === "client/turn/requested")!;
      const start = getLatestThreadSequence(h.db,{threadId});
      for (let i = 1; i <= 1001; i++) {
        const sequence = start + i;
        seedEvent(h.deps, {threadId, sequence, scope: threadScope(), type: "client/turn/requested",
          data: {...JSON.parse(prior.data), requestId: encodeClientTurnRequestIdNumber({value:sequence})}});
      }
      resetPlacementOwnerAvailability(h.db);
      const path = join(h.config.dataDir, "history-review.sqlite");
      await h.db.$client.backup(path);
      const db = createConnection(path);
      try {
        const app = createApp({...h.deps, db}).app;
        const changes = () => db.$client.prepare("select total_changes()").pluck().get();
        const before = changes();
        for (const id of f.queueIds) {
          const replay = await f.send(app, id);
          expect(replay.status).toBe(409);
          expect(await replay.json()).toEqual(original);
          const denied = await f.send(app,id,"another-principal");
          expect(denied.status).toBe(404);
        }
        expect(changes()).toBe(before);
        archiveThread(db,h.hub,threadId);
        const afterArchive=changes();
        const archived=await f.send(app,f.queueIds[0]);
        expect(archived.status).toBe(409);
        expect((await archived.json()).code).toBe("thread_not_writable");
        expect(changes()).toBe(afterArchive);
        expect(entry).toHaveBeenCalledTimes(1);
        console.log("laterRequests=1001 ownerUnavailable=true authorizedReplay=identical wrongScope=404 archived=thread_not_writable replayWrites=0 replayHandoffs=0");
      } finally { db.$client.close(); }
    } finally {entry.mockRestore();}
  });
});
