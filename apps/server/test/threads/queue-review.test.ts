import { it, expect, vi } from "vitest";
import { join } from "node:path";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { withTestHarness } from "../helpers/test-app.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import { claimQueuedThreadMessageGroup, createConnection, getQueuedThreadMessage, listEvents, readPlacementDispatchReceipt } from "@bb/db";

it("replays terminal receipts after reopen even while new input is paused", async () => {
  await withTestHarness(async h => {
    const f = seedManagedGroup(h, {firstInputShape:"grouped"});
    const entry = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
    try {
      const floor=listEvents(h.db,{threadId:f.threadId}).length;
      const response = await f.send();
      const original = await response.json();
      expect(response.status).toBe(409);
      expect(original.details.state).toBe("refused_unsent");
      const path = join(h.config.dataDir, "review.sqlite");
      await h.db.$client.backup(path);
      const db = createConnection(path);
      try {
        const app = createApp({...h.deps,db}).app;
        const events = listEvents(db,{threadId:f.threadId}).slice(floor);
        const requests = events.filter(e=>e.type==="client/turn/requested");
        const rejections = events.filter(e=>e.type==="client/turn/rejected");
        expect([requests.length,rejections.length]).toEqual([1,1]);
        const request = JSON.parse(requests[0]!.data);
        expect(request.clientSubmissions).toEqual(f.members.map((m,i)=>({id:m.clientSubmissionId,inputGroupIndex:i*2})));
        expect(request.sourceQueuedMessageIds).toEqual(f.queueIds);
        expect(JSON.parse(rejections[0]!.data).requestId).toBe(request.requestId);
        expect(readPlacementDispatchReceipt(db,{threadId:f.threadId,requestId:request.requestId})).toMatchObject({commandId:null,nativeExecutionId:null,state:"refused_unsent"});
        expect(listQueuedThreadCommands(h,"turn.submit",f.threadId)).toHaveLength(0);
        for(const q of f.queueIds) expect(await (await f.send(app,q)).json()).toEqual(original);
        expect(entry).toHaveBeenCalledTimes(1);
        console.log("requests=1 rejections=1 runtime=1 submit=0 replayRuntime=0",request.requestId,requests[0]!.sequence);
        const wait = vi.spyOn(h.deps.pendingInteractions,"hasTurnBoundPendingThreadInteraction").mockReturnValue(true);
        try {
          const result=await (await f.send(app,f.queueIds[1])).json();
          console.log("terminal replay while waiting",result.code);
          expect(result).toEqual(original);
        }finally{wait.mockRestore()}
      }finally{db.$client.close()}
    }finally{entry.mockRestore()}
  });
});
it("reports a missing boundary target consistently across unrelated claims",async()=>{
  await withTestHarness(async h=>{
    const f=seedManagedGroup(h);
    const missing="qsub_"+crypto.randomUUID();
    const lookup=()=>h.app.request("/api/v1/threads/"+f.threadId+"/queued-messages/group-boundary",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({groupBoundaryQueuedMessageId:missing,expectedGroupedPrefixQueuedMessageIds:[missing]})});
    expect((await lookup()).status).toBe(404);
    expect(claimQueuedThreadMessageGroup(h.db,h.hub,f.queueIds[0]!,{kind:"explicit-send"})).toHaveLength(2);
    const held=await lookup();
    console.log("missing boundary with unrelated claim",held.status,await held.json());
    expect(held.status).toBe(404);
  });
});
it("denies a mixed-actor group while the native token hides its rows",async()=>{
  await withTestHarness(async h=>{
    const f=seedManagedGroup(h,{secondPrincipal:"different"});
    const batch=claimQueuedThreadMessageGroup(h.db,h.hub,f.queueIds[0]!,{kind:"explicit-send"})!;
    expect(batch).toHaveLength(2);
    const missing=await f.send(h.app,"qsub_"+crypto.randomUUID());
    for(const id of f.queueIds){
      const response=await f.send(h.app,id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(await missing.clone().json());
      expect(getQueuedThreadMessage(h.db,id)?.claimToken).toBe(batch[0]!.claimToken);
    }
  });
});
