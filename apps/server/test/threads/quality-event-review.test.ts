import {join} from "node:path";
import {createConnection, deleteThreadEventSuffixInTransaction, getLatestThreadSequence, listEvents, readPlacementAdmittedExecution, readPlacementDispatchReceipt} from "@bb/db";
import {encodeClientTurnRequestIdNumber, threadScope, turnScope} from "@bb/domain";
import {expect, it, vi} from "vitest";
import {createApp} from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import {appendThreadEventInTransaction} from "../../src/services/threads/thread-events.js";
import {listQueuedThreadCommands} from "../helpers/commands.js";
import {purpose, seedManagedGroup} from "../helpers/managed-ordinary-queue.js";
import {seedStoredEvent} from "../helpers/seed.js";
import {withTestHarness} from "../helpers/test-app.js";

it.each(["deleted","same sequence, new request","reinserted request","rewritten request and rejection"])("replays a detached receipt safely: %s", async variant => {
  await withTestHarness(async h => {
    const f = seedManagedGroup(h);
    const threadId = f.threadId;
    const handoff = vi.spyOn(runtime,"dispatchManagedOrdinaryTurn");
    try {
      const initial = await f.send();
      const original = await initial.json();
      expect([initial.status, original.code, original.details.state]).toEqual([409,"managed_execution_unsupported","refused_unsent"]);
      const {requestId,sequence} = original.details.requested;
      const key = {threadId, requestId};
      const receipt = readPlacementDispatchReceipt(h.db,key)!;
      expect(receipt.liveEventId).toEqual(receipt.eventId);
      const request = listEvents(h.db,{threadId}).find(row => row.sequence === sequence)!;
      h.db.transaction(tx => {
        const cut = deleteThreadEventSuffixInTransaction(tx, {
          threadId, cutoffSequence:sequence, oldMaxSequence:getLatestThreadSequence(tx,{threadId})
        });
        expect(cut.deletedEventCount).toBe(2);
        if (variant === "deleted") return;
        const data = JSON.parse(request.data);
        if (variant === "same sequence, new request") data.requestId = encodeClientTurnRequestIdNumber({value:824});
        if (variant === "rewritten request and rejection") {
          data.input[0].text = "replacement";
          if (data.inputGroups) data.inputGroups[0][0].text = "replacement";
        }
        const assigned = appendThreadEventInTransaction(tx,{threadId,type:"client/turn/requested",scope:threadScope(), data});
        expect(assigned).toBe(sequence);
        if (variant === "rewritten request and rejection")
          appendThreadEventInTransaction(tx,{threadId,type:"client/turn/rejected",scope:threadScope(),data:{requestId,reason:"managed_admission_unavailable",message:"Replacement rejection"}});
      });
      if (variant !== "deleted") {
        const replacement = listEvents(h.db,{threadId}).find(row => row.sequence === sequence)!;
        expect(replacement.id).not.toBe(receipt.eventId);
      }
      const path = join(h.config.dataDir,"detached.sqlite");
      await h.db.$client.backup(path);
      const db = createConnection(path);
      try {
        const {app} = createApp({...h.deps,db});
        const getChanges = () => db.$client.prepare("SELECT total_changes()").pluck().get();
        const before = getChanges();
        expect(readPlacementDispatchReceipt(db,key)).toEqual({...receipt,liveEventId:null});
        expect(readPlacementAdmittedExecution(db,{...key,purpose})).toBeNull();
        const codes = [];
        for (const id of f.queueIds) {
          const denied = await f.send(app,id,"another-principal");
          expect([denied.status,await denied.json()]).toEqual([404,{code:"invalid_request",message:"Queued message not found"}]);
          const response = await f.send(app,id);
          const body = await response.json();
          expect(response.status).toBe(409);
          codes.push(body.code);
        }
        expect(getChanges()).toEqual(before);
        expect(handoff).toHaveBeenCalledTimes(1);
        for(const type of ["turn.submit","thread.start"] as const)
          expect(listQueuedThreadCommands(h,type,threadId)).toHaveLength(0);
        console.log(variant,JSON.stringify({codes,original:original.code,liveEventId:null,admitted:false,wrongPrincipal:404,writes:0,replayHandoffs:0,submits:0}));
        expect(codes).toEqual(["placement_dispatch_unavailable","placement_dispatch_unavailable"]);
      } finally {db.$client.close();}
    } finally {handoff.mockRestore();}
  });
});

it("exercises the native edit HTTP gate on a managed thread",async()=>{
  await withTestHarness(async h=>{
    const f = seedManagedGroup(h);
    const threadId = f.threadId;
    const prior = listEvents(h.db,{threadId}).find(row=>row.type==="client/turn/requested")!;
    const scope = turnScope("earlier");
    const providerThreadId = "guest-session-worker";
    const seed = {threadId, scope, providerThreadId};
    seedStoredEvent(h.deps,{...seed,sequence:3,type:"turn/started",data:{providerThreadId}});
    seedStoredEvent(h.deps,{...seed,sequence:4,type:"turn/input/accepted",data:{providerThreadId,clientRequestId:JSON.parse(prior.data).requestId}});
    seedStoredEvent(h.deps,{...seed,sequence:5,type:"turn/completed",data:{providerThreadId,status:"completed",providerCheckpointId:"test-checkpoint"}});
    const original = await (await f.send()).json();
    expect(original.details.state).toBe("refused_unsent");
    const resp = await h.app.request("/api/v1/threads/"+threadId+"/edit-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:"qa-edit",expectedRequestSequence:prior.sequence,input:[{type:"text",text:"Edited earlier turn",mentions:[]}]})});
    const body = await resp.json();
    console.log("actual edit route",resp.status,body);
    expect([resp.status,body.code]).toEqual([409,"placement_dispatch_unavailable"]);
    const key = {threadId,requestId:original.details.requested.requestId};
    const receipt = readPlacementDispatchReceipt(h.db,key)!;
    expect(receipt.liveEventId).toEqual(receipt.eventId);
  });
});

it("checks registration of the specified A2 operation list and detail reads after detach", async () => {
  await withTestHarness(async h => {
    const f = seedManagedGroup(h);
    const body = await (await f.send()).json();
    const key = {threadId:f.threadId, requestId:body.details.requested.requestId};
    h.db.transaction(tx => deleteThreadEventSuffixInTransaction(tx, {
      threadId:f.threadId, cutoffSequence:body.details.requested.sequence,
      oldMaxSequence:getLatestThreadSequence(tx,{threadId:f.threadId}),
    }));
    const path = join(h.config.dataDir,"get.sqlite");
    await h.db.$client.backup(path);
    const db = createConnection(path);
    try {
      const {app} = createApp({...h.deps,db, resolvePlacementSendScope:() => ({principal:"local", identity:"local-unverified", authority:"local-input-parity"})});
      expect(readPlacementDispatchReceipt(db,key)).toMatchObject({liveEventId:null,state:"refused_unsent"});
      for (const route of ["/api/v1/placement/operations","/api/v1/placement/operations/"+f.members[0].id]) {
        const result = await app.request(route);
        console.log("GET",route,result.status,(await result.text()).slice(0,170));
        expect(result.status).toBe(404);
      }
    } finally { db.$client.close(); }
  });
});
