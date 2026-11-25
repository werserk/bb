import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import { PLUGIN_RPC_CALLER_HEADER } from "../services/plugins/plugin-rpc-caller.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import type {
  PlacementInvocation,
  PlacementService,
} from "../services/placement/placement-service.js";

/**
 * Placement ingress. The caller identity comes only from the server: no
 * plugin caller token is an ordinary local client (`local-unverified`), a
 * valid per-load token is that plugin, and an unknown or revoked token is
 * refused rather than downgraded to a client.
 */
export function registerPlacementRoutes(
  app: Hono,
  placement: PlacementService,
  plugins: Pick<PluginService, "resolveRpcCaller">,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.placement;
  const invocation = (context: {
    req: { header(name: string): string | undefined };
  }): PlacementInvocation => {
    const resolved = plugins.resolveRpcCaller(
      context.req.header(PLUGIN_RPC_CALLER_HEADER),
    );
    if (!resolved.ok)
      throw new ApiError(
        403,
        "forbidden",
        `The ${PLUGIN_RPC_CALLER_HEADER} token is not a running plugin's caller token`,
      );
    return resolved.caller.kind === "plugin"
      ? { kind: "plugin", pluginId: resolved.caller.pluginId }
      : { kind: "client" };
  };
  post(routes.accept, async (context, payload) =>
    context.json(await placement.accept(invocation(context), payload)),
  );
  get(routes.get, (context) =>
    context.json(placement.get(invocation(context), context.req.param("id"))),
  );
  get(routes.recoverDraft, (context) =>
    context.json(
      placement.recoverDraft(invocation(context), context.req.param("id")),
    ),
  );
  post(routes.cancel, (context) =>
    context.json(placement.cancel(invocation(context), context.req.param("id"))),
  );
}
