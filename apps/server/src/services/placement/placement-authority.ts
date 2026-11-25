import { getThread } from "@bb/db";
import type { PermissionMode, PlacementAuthority } from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { throwSenderThreadInvalid } from "../lib/lifecycle-api-errors.js";
import { resolveDispatchAuthor } from "../threads/dispatch-author.js";
import { assertServiceTurnScope } from "../threads/service-turn-scope.js";
import { assertThreadCreateRelationships } from "../threads/thread-create.js";
import { resolveMessageSenderThreadId } from "../threads/thread-send.js";
import { resolvePermissionEscalation } from "../threads/thread-runtime-config.js";

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

function liveSender(deps: Pick<AppDeps, "db">, senderThreadId: string) {
  const sender = getThread(deps.db, senderThreadId);
  if (!sender) throwSenderThreadInvalid("not_found");
  if (sender.deletedAt !== null) throwSenderThreadInvalid("deleted");
  return sender.id;
}

/**
 * Derives the durable action authority from the authenticated caller after
 * the same project, source, sender and service-scope checks a native create
 * or send performs. Request attribution is never trusted on its own.
 */
export function derivePlacementAuthority(
  deps: Pick<AppDeps, "db">,
  args: {
    invocation: PlacementInvocation;
    request: PlacementRequestV1;
    permission: PermissionMode;
  },
): PlacementAuthority {
  const authority = withoutEscalation(deps, args);
  return {
    ...authority,
    escalation: resolvePermissionEscalation({ initiator: authority.initiator }),
  };
}

function withoutEscalation(
  deps: Pick<AppDeps, "db">,
  args: {
    invocation: PlacementInvocation;
    request: PlacementRequestV1;
    permission: PermissionMode;
  },
): Omit<PlacementAuthority, "escalation"> {
  const { invocation, request } = args;
  const principal = placementPrincipal(invocation);
  const actor = invocation.kind === "client" ? "local-unverified" : "plugin";
  const intent = request.intent;
  switch (intent.kind) {
    case "independent": {
      const body = intent.request;
      const plugin = verifiedPlugin(invocation, body.originPluginId);
      assertThreadCreateRelationships(deps, body);
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
        plugin,
        requestedBy: body.startedOnBehalfOf,
        sender:
          author.senderThreadId ??
          (body.senderThreadId === undefined
            ? null
            : liveSender(deps, body.senderThreadId)),
        initiator: author.initiator,
        permission: args.permission,
        serviceTurn: null,
      };
    }
    case "continuation": {
      const body = intent.request;
      const plugin = verifiedPlugin(invocation, body.originPluginId);
      const thread = requirePublicThread(deps.db, intent.threadId);
      if (body.serviceTurn !== undefined)
        assertServiceTurnScope(deps, {
          callerPluginId: invocation.kind === "plugin" ? invocation.pluginId : null,
          serviceTurn: body.serviceTurn,
          senderThreadId: body.senderThreadId ?? null,
          thread,
        });
      const author = resolveDispatchAuthor({
        retrying: false,
        systemNotice: false,
        senderThreadId: resolveMessageSenderThreadId(deps, {
          senderThreadId: body.senderThreadId,
          targetThread: thread,
        }),
        startedOnBehalfOf: null,
      });
      return {
        principal,
        actor,
        origin: null,
        plugin,
        requestedBy: null,
        sender: author.senderThreadId,
        initiator: author.initiator,
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
        permission: args.permission,
        serviceTurn: null,
      };
  }
}
