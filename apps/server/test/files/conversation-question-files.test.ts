import { createHash } from "node:crypto";
import { createConversationQuestion, updateThread } from "@bb/db";
import { conversationQuestionPublicationSchema } from "@bb/domain";
import { it, expect } from "vitest";
import { seedThreadFixture } from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { withTestHarness } from "../helpers/test-app.js";

it("serves only manifest snapshots from the original host after thread environment changes", async () => {
  await withTestHarness(async (h) => {
    const { thread, host, session } = seedThreadFixture(h);
    const bytes = Buffer.from("audio fixture bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = {
      originalPath: "sample.mp3",
      snapshotPath: "question-materials/qst_23456789ab/sample.mp3",
      label: "Sample",
      sha256,
      snapshotRevision: "1".repeat(64),
      sizeBytes: bytes.length,
      mimeType: "audio/mpeg",
    };
    const publication = conversationQuestionPublicationSchema.parse({
      questions: [
        {
          id: "voice",
          prompt: "Which?",
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    });
    const question = createConversationQuestion(h.db, {
      threadId: thread.id,
      sourceTurnId: null,
      sourceCallId: null,
      publication: JSON.stringify(publication),
      materialManifest: JSON.stringify({
        hostId: host.id,
        storageRootPath: "/original-storage",
        materials: [{ ...file, dependencies: [] }],
        files: [file],
      }),
    })!;
    const next = seedThreadFixture(h);
    updateThread(h.db, h.deps.hub, thread.id, {
      environmentId: next.environment.id,
    });
    let revision = file.snapshotRevision;
    const commands: string[] = [];
    registerHostRpcResponder(h, {
      hostId: host.id,
      sessionId: session.id,
      handle: ({ command }) => {
        if (command.type !== "host.read_file_chunk")
          throw new Error("Unexpected command");
        expect(command.rootPath).toBe("/original-storage");
        commands.push(command.path);
        return {
          ok: true,
          result: {
            path: command.path,
            content: bytes
              .subarray(command.offset, command.offset + command.length)
              .toString("base64"),
            offset: command.offset,
            sizeBytes: bytes.length,
            mimeType: "audio/mpeg",
            modifiedAtMs: 1,
            revision,
          },
        };
      },
    });
    const url = `/api/v1/threads/${thread.id}/questions/${question.id}/files/${file.snapshotPath}`;
    const response = await h.app.request(url, {
      headers: { range: "bytes=0-4" },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("audio");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(
      commands.every(
        (command) => command === `/original-storage/${file.snapshotPath}`,
      ),
    ).toBe(true);
    const count = commands.length;
    expect(
      (await h.app.request(url.replace("sample.mp3", "unlisted.mp3"))).status,
    ).toBe(404);
    expect(commands).toHaveLength(count);
    revision = "0".repeat(64);
    expect((await h.app.request(url)).status).toBe(409);
    expect(
      (await h.app.request(url.replace(thread.id, next.thread.id))).status,
    ).toBe(404);
  });
});
