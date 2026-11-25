import { getLatestSessionForHost, upsertHost } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { expect, it } from "vitest";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

it.each([270, 271])(
  "opens a synthetic daemon session only on the matching server revision (peer %i)",
  async (protocolVersion) => {
    const server = await startTestServer();
    try {
      const hostId = "codec-open-test";
      upsertHost(server.db, server.hub, {
        id: hostId,
        name: "Protocol fixture",
      });
      const key = createTestDaemonHostKey({ hostId });
      const result = await fetch(server.baseUrl + "/internal/session/open", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          hostId,
          instanceId: "fixture-instance",
          hostName: "fixture",
          hasMachineCredential: false,
          platform: "linux",
          dataDir: "/scratch/fixture",
          localApiPort: null,
          protocolVersion,
          activeThreads: [],
          openThreadWork: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
        }),
      });
      const session = getLatestSessionForHost(server.db, { hostId });
      if (protocolVersion === HOST_DAEMON_PROTOCOL_VERSION) {
        expect(result.status).toBe(201);
        expect(session?.protocolVersion).toBe(protocolVersion);
      } else {
        expect(result.status).toBe(400);
        expect(await result.json()).toMatchObject({
          code: "protocol_version_mismatch",
          details: { serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION },
        });
        expect(session).toBeNull();
      }
    } finally {
      await server.close();
    }
  },
);
