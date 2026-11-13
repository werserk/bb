import { z } from "zod";
import type { QueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import {
  setPendingSendIdentity,
  setPendingSendIdentityRetry,
} from "./pending-send-owner";

const statusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("signed-out"),
    revision: z.number(),
    account: z.null(),
  }),
  z.object({
    state: z.literal("profile-pending"),
    revision: z.number(),
    account: z.null(),
  }),
  z.object({
    state: z.literal("signed-in"),
    revision: z.number(),
    account: z.object({
      userId: z.string(),
      serverId: z.string(),
      baseUrl: z.string(),
    }),
  }),
]);

export function bindPendingSendIdentity(client: QueryClient) {
  let revision = -1;
  let epoch = 0;
  let disposed = false;
  setPendingSendIdentity(client, null);
  const apply = (value: unknown) => {
    const parsed = statusSchema.safeParse(value);
    if (!parsed.success || disposed || parsed.data.revision < revision) return;
    const status = parsed.data;
    revision = status.revision;
    setPendingSendIdentity(
      client,
      status.state === "signed-in"
        ? JSON.stringify([
            status.account.baseUrl,
            status.account.userId,
            status.account.serverId,
          ])
        : status.state === "signed-out"
          ? "signed-out"
          : null,
    );
  };
  let active: Promise<void> | undefined;
  const read = (force = false) => {
    if (active && !force) return active;
    const started = ++epoch;
    const promise = (async () => {
      try {
        const status = await sdk.plugins.callRpc({
          pluginId: "bb-account",
          method: "bb-account.v1.status",
          input: null,
          outputSchema: statusSchema,
        });
        if (started === epoch) apply(status);
      } catch {}
    })().finally(() => {
      if (active === promise) active = undefined;
    });
    active = promise;
    return promise;
  };
  const offSignal = wsManager.onPluginSignal((signal) => {
    if (signal.pluginId !== "bb-account" || signal.channel !== "account")
      return;
    const payload = z
      .object({ status: statusSchema })
      .safeParse(signal.payload);
    if (!payload.success) return;
    epoch++;
    apply(payload.data.status);
  });
  const offConnected = wsManager.onConnected(() => {
    setPendingSendIdentity(client, null);
    revision = -1;
    void read(true);
  });
  setPendingSendIdentityRetry(client, read);
  void read();
  return () => {
    disposed = true;
    epoch++;
    offSignal();
    offConnected();
    setPendingSendIdentityRetry(client, undefined);
  };
}
