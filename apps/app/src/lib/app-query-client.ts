import { bindPendingSendIdentity } from "@/hooks/cache-owners/pending-send-identity";
import { createAppQueryClient } from "./query-client";
import { wsManager } from "./ws";

export const appQueryClient = createAppQueryClient({
  shouldRefetchOnWindowFocus: () =>
    wsManager.getConnectionState() !== "connected",
});

bindPendingSendIdentity(appQueryClient);
