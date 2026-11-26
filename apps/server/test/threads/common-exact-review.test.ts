import { join } from "node:path";
import { createConnection, deleteThreadEventSuffixInTransaction, getLatestThreadSequence, listEvents, readPlacementDispatchReceipt } from "@bb/db";
import { threadScope } from "@bb/domain";
import { expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import * as dispatch from "../../src/services/threads/queued-message-dispatch.js";
import { appendThreadEventInTransaction } from "../../src/services/threads/thread-events.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { withTestHarness } from "../helpers/test-app.js";

it.each(["untouched", "replace rejection", "replace both", "wrong principal read boundary"])("%s after reopen", async variant => {
  await withTestHarness(async h => {
    const f = seedManagedGroup(h);
    const threadId = f.threadId;
    const handoff = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
    try {
      const first = await f.send();
      const original = await first.json();
      expect([first.status,original.details.state]).toEqual([409,"refused_unsent"]);
      const {requestId} = original.details.requested;
      const key = {threadId,requestId};
      const originalReceipt = readPlacementDispatchReceipt(h.db,key)!;
      expect(originalReceipt.rejectionReason).toBe("managed_execution_unsupported");
      const history = listEvents(h.db,{threadId});
      const req = history.find(row=>row.id===originalReceipt.eventId)!;
      const rej = history.find(row=>row.type==="client/turn/rejected" && JSON.parse(row.data).requestId===requestId)!;
      expect(JSON.parse(rej.data).reason).toBe("managed_execution_unsupported");
      expect(originalReceipt.rejectionEventId).toBe(rej.id);
      expect(originalReceipt.liveRejectionEventId).toBe(rej.id);
      expect(original.code).toBe(originalReceipt.rejectionReason);
      expect(handoff).toHaveBeenCalledTimes(1);
      if (variant.startsWith("replace")) {
        h.db.transaction(tx=>{
          const replaceRequest = variant==="replace both";
          const cut = deleteThreadEventSuffixInTransaction(tx,{
            threadId,cutoffSequence:replaceRequest ? req.sequence : rej.sequence,oldMaxSequence:getLatestThreadSequence(tx,{threadId})
          });
          expect(cut.deletedEventCount).toBe(replaceRequest ? 2 : 1);
          if (replaceRequest) {
            const data = JSON.parse(req.data);
            data.input[0].text = "replacement";
            if (data.inputGroups) data.inputGroups[0][0].text = "replacement";
            expect(appendThreadEventInTransaction(tx,{threadId,scope:threadScope(),type:"client/turn/requested",data})).toBe(req.sequence);
          }
          expect(appendThreadEventInTransaction(tx,{threadId,scope:threadScope(),type:"client/turn/rejected",data:{requestId,reason:"managed_admission_unavailable",message:"replacement"}})).toBe(rej.sequence);
        });
      }
      const path = join(h.config.dataDir,"review.sqlite");
      await h.db.$client.backup(path);
      const statements: string[] = [];
      const db = createConnection(path,{slowQueryThresholdMs:0,slowQueryLogger:{info(fields) {statements.push(fields.sql);}}});
      try {
        const receipt = readPlacementDispatchReceipt(db,key)!;
        const detached = variant==="replace both";
        expect(receipt).toEqual({...originalReceipt,liveEventId:detached ? null : req.id,liveRejectionEventId:variant.startsWith("replace") ? null : rej.id});
        const reopened = listEvents(db,{threadId});
        const currentReq = reopened.find(row=>row.sequence===req.sequence)!;
        const currentRej = reopened.find(row=>row.sequence===rej.sequence)!;
        expect(JSON.parse(currentReq.data).requestId).toBe(requestId);
        expect(currentReq.id===req.id).toBe(!detached);
        expect(currentRej.id===rej.id).toBe(!variant.startsWith("replace"));
        const {app} = createApp({...h.deps,db});
        const wake = vi.spyOn(dispatch,"requestQueuedMessageDispatch");
        const notify = vi.spyOn(h.hub,"notifyThread");
        try {
          const changes = () => db.$client.prepare("SELECT total_changes()").pluck().get();
          const before = changes();
          const deniedReads: string[] = [];
          const expected = detached ? "placement_dispatch_unavailable" : "managed_execution_unsupported";
          for (const id of f.queueIds) {
            statements.length = 0;
            const denied = await f.send(app,id,"different-principal");
            expect([denied.status,await denied.json()]).toEqual([404,{code:"invalid_request",message:"Queued message not found"}]);
            const effectReads = statements.filter(s=>s.includes('"placement_effect"."state"') && s.includes('join "placement_effect"'));
            deniedReads.push(...effectReads);
            expect(statements.some(s=>s.startsWith("select"))).toBe(true);
            if (variant==="wrong principal read boundary") continue;
            const res = await f.send(app,id);
            const body = await res.json();
            expect(res.status).toBe(409);
            console.log(variant, "first="+original.code,"replay="+body.code,"state="+(body.details?.state??"absent"));
            expect(body.code).toBe(expected);
            if (!detached) expect(body).toEqual(original);
            if (detached) expect(body.details).toBeUndefined();
            else expect(body.details).toEqual(original.details);
          }
          expect(changes()).toBe(before);
          expect(handoff).toHaveBeenCalledTimes(1);
          expect(wake).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
          for (const kind of ["turn.submit","thread.start"] as const) expect(listQueuedThreadCommands(h,kind,threadId)).toHaveLength(0);
          console.log(variant, "wrongPrincipal=404","replayWrites=0","replayHandoffs=0","wake=0","notify=0","start/submit=0","foreignEffectHistoryReads="+deniedReads.length);
          if (variant==="wrong principal read boundary") {
            if (deniedReads.length) console.log("executed read",deniedReads[0]);
            expect(deniedReads).toHaveLength(0);
          }
        } finally {wake.mockRestore();notify.mockRestore();}
      } finally {db.$client.close();}
    } finally {handoff.mockRestore();}
  });
});
