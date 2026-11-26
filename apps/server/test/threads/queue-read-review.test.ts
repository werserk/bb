import { join } from "node:path";
import { createConnection, claimQueuedThreadMessageGroup } from "@bb/db";
import { expect, it, vi } from "vitest";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { withTestHarness } from "../helpers/test-app.js";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";

it.each(["live","claimed"])("checks the native queue fields returned to the server before rejection (%s)",async stage=>{
  await withTestHarness(async h=>{
    const f=seedManagedGroup(h,{secondPrincipal:"foreign"});
    if(stage==="claimed") expect(claimQueuedThreadMessageGroup(h.db,h.hub,f.queueIds[0]!,{kind:"explicit-send"})).toHaveLength(2);
    const path=join(h.config.dataDir,"members.sqlite");
    await h.db.$client.backup(path);
    const db=createConnection(path);
    try {
      const app=createApp({...h.deps,db}).app;
      const handoff=vi.spyOn(runtime,"dispatchManagedOrdinaryTurn");
      try {
        const nativePrepare=db.$client.prepare.bind(db.$client);
        const observed: string[]=[];
        db.$client.prepare=function(source) {
          const stmt=nativePrepare(source);
          if (!/^select/i.test(source) || !/from "queued_thread_messages"/i.test(source)) return stmt;
          const names=stmt.columns().map(col=>col.name);
          const idIndex=names.indexOf("id");
          const contentIndex=names.indexOf("content");
          if(idIndex<0 || contentIndex<0) return stmt;
          for(const method of ["get","all"] as const){
            const exec=stmt[method].bind(stmt);
            stmt[method]=(...params)=>{
              const result=exec(...params);
              for(const row of method==="get"?[result]:result){
                if (!row) continue;
                const id=Array.isArray(row)?row[idIndex]:row.id;
                const content=Array.isArray(row)?row[contentIndex]:row.content;
                if(id===f.queueIds[1] && typeof content==="string" && content.length) observed.push(method);
              }
              return result;
            };
          }
          return stmt;
        };
        const before=db.$client.prepare("select total_changes()").pluck().get();
        const denied=await f.send(app,f.queueIds[0],"local");
        expect([denied.status,await denied.json()]).toEqual([404,{code:"invalid_request",message:"Queued message not found"}]);
        expect(db.$client.prepare("select total_changes()").pluck().get()).toEqual(before);
        expect(handoff).not.toHaveBeenCalled();
        console.log("stage="+stage,"callerOwns=head","otherMember=foreign","http=404","foreignNonemptyContentRows="+observed.length,"sqliteChanges=0","handoffs=0");
        expect(observed).toHaveLength(0);
      } finally {handoff.mockRestore();}
    } finally {db.$client.close();}
  });
});
