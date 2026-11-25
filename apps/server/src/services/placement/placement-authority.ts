import type { PermissionMode, PlacementAuthority } from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import { resolveDispatchAuthor } from "../threads/dispatch-author.js";

export type PlacementInvocation =
  | { kind: "client" }
  | { kind: "plugin"; pluginId: string };

export function placementPrincipal(invocation: PlacementInvocation): string {
  return invocation.kind === "client" ? "local" : `plugin:${invocation.pluginId}`;
}

function verifiedPlugin(
  invocation: PlacementInvocation,
  claimed: string | undefined,
): string | null {
  if (invocation.kind === "client") return null;
  if (claimed !== undefined && claimed !== invocation.pluginId)
    throw new ApiError(
      403,
      "forbidden",
      "A plugin cannot submit placement on behalf of another plugin",
    );
  return invocation.pluginId;
}

export function derivePlacementAuthority(args: {
  invocation: PlacementInvocation;
  request: PlacementRequestV1;
  permission: PermissionMode;
}): PlacementAuthority {
  const { invocation, request } = args;
  const principal = placementPrincipal(invocation);
  const actor = invocation.kind === "client" ? "local-unverified" : "plugin";
  const intent = request.intent;
  switch (intent.kind) {
    case "independent": {
      const body = intent.request;
      const author = resolveDispatchAuthor({
        retrying: false,
        systemNotice: false,
        senderThreadId: null,
        startedOnBehalfOf: body.startedOnBehalfOf,
      });
      return {
        principal,
        actor,
        origin: body.origin,
        plugin: verifiedPlugin(invocation, body.originPluginId),
        requestedBy: body.startedOnBehalfOf,
        sender: author.senderThreadId ?? body.senderThreadId ?? null,
        initiator: author.initiator,
        escalation: null,
        permission: args.permission,
        serviceTurn: null,
      };
    }
    case "continuation": {
      const body = intent.request;
      if (
        body.serviceTurn !== undefined &&
        (invocation.kind !== "plugin" ||
          invocation.pluginId !== body.serviceTurn.origin.pluginId)
      )
        throw new ApiError(
          403,
          "forbidden",
          "Service input requires its authenticated plugin",
        );
      const author = resolveDispatchAuthor({
        retrying: false,
        systemNotice: false,
        senderThreadId: body.senderThreadId ?? null,
        startedOnBehalfOf: null,
      });
      return {
        principal,
        actor,
        origin: null,
        plugin: verifiedPlugin(invocation, body.originPluginId),
        requestedBy: null,
        sender: author.senderThreadId,
        initiator: author.initiator,
        escalation: null,
        permission: args.permission,
        serviceTurn: body.serviceTurn ?? null,
      };
    }
    case "fork": {
      const body = intent.request;
      return {
        principal,
        actor,
        origin: body.origin,
        plugin: verifiedPlugin(invocation, body.originPluginId),
        requestedBy: null,
        sender: null,
        initiator: "user",
        escalation: null,
        permission: args.permission,
        serviceTurn: null,
      };
    }
    case "retry":
      return {
        principal,
        actor,
        origin: null,
        plugin: verifiedPlugin(invocation, undefined),
        requestedBy: null,
        sender: null,
        initiator: "system",
        escalation: null,
        permission: args.permission,
        serviceTurn: null,
      };
  }
}
