import { listEvents, listQueuedThreadMessages, setQueuedThreadMessageGroupBoundary } from "@bb/db";
import { expect, it } from "vitest";
import { textInput } from "../helpers/prompt-input.js";
import { seedEnvironment, seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";

it.each(["single", "grouped"])("scheduled native pending first Send now (%s)", async mode => {
  await withTestHarness(async h => {
    const { host } = seedHostSession(h.deps);
    const { project } = seedProjectWithSource(h.deps,{hostId:host.id});
    const env = seedEnvironment(h.deps,{hostId:host.id,projectId:project.id});
    const sendAt = Date.now()+3600000;
    const post = (url:string,body:object) => h.app.request(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const created = await post("/api/v1/threads",{origin:"app",projectId:project.id,providerId:"codex",environment:{type:"reuse",environmentId:env.id},input:textInput("scheduled"),clientSubmissionId:crypto.randomUUID(),sendAt});
    expect(created.status).toBe(201);
    const thread = await created.json();
    expect(thread.status).toBe("pending");
    if(mode==="grouped") {
      const queued = await post("/api/v1/threads/"+thread.id+"/send",{input:textInput("later"),clientSubmissionId:crypto.randomUUID(),mode:"queue-if-active",sendAt:sendAt+60000});
      expect(queued.status).toBe(200);
    }
    const rows = listQueuedThreadMessages(h.db,thread.id);
    if(mode==="grouped") expect(setQueuedThreadMessageGroupBoundary({db:h.db,notifier:h.hub,threadId:thread.id,groupBoundaryQueuedMessageId:rows[1]!.id,expectedGroupedPrefixQueuedMessageIds:rows.map(r=>r.id)}).kind).toBe("updated");
    await runQueuedMessageDispatch(h.deps,{kind:"time-reached",now:Date.now()});
    expect(listEvents(h.db,{threadId:thread.id}).filter(e=>e.type==="client/turn/requested")).toHaveLength(0);
    const sent = await post("/api/v1/threads/"+thread.id+"/queued-messages/"+rows[0]!.id+"/send",{mode:"auto"});
    const body = await sent.json();
    const events = listEvents(h.db,{threadId:thread.id}).filter(e=>e.type==="client/turn/requested");
    console.log(mode, {http:sent.status,sourceRows:rows.length,allFuture:rows.every(r=>r.sendAt!>Date.now()),requested:events.length,consumed:rows.length-listQueuedThreadMessages(h.db,thread.id).length,kind:events[0]&&JSON.parse(events[0].data).target.kind});
    expect(sent.status,JSON.stringify(body)).toBe(200);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toMatchObject({target:{kind:"thread-start"},sourceQueuedMessageIds:rows.map(r=>r.id)});
  });
});
