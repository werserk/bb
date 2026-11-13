import { z } from "zod";
import type { QueryClient } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { setPendingSendIdentity } from "./pending-send-owner";

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
  const read = async () => {
    const started = ++epoch;
    try {
      const status = await sdk.plugins.callRpc({
        pluginId: "bb-account",
        method: "bb-account.v1.status",
        input: null,
        outputSchema: statusSchema,
      });
      if (started === epoch) apply(status);
    } catch {}
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
    revision = -1;
    void read();
  });
  void read();
  return () => {
    disposed = true;
    epoch++;
    offSignal();
    offConnected();
  };
}
