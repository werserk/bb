import type { PlacementOperation } from "@bb/domain";
import type {
  PlacementAcceptance,
  PlacementDraftRecovery,
  PlacementRequestV1,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

type OperationArgs = { operationId: string; signal?: AbortSignal };

export interface ExperimentalPlacementArea {
  accept(
    request: PlacementRequestV1,
    options?: { signal?: AbortSignal },
  ): Promise<PlacementAcceptance>;
  get(args: OperationArgs): Promise<PlacementOperation>;
  recoverDraft(args: OperationArgs): Promise<PlacementDraftRecovery>;
  cancel(args: OperationArgs): Promise<PlacementOperation>;
}

export function createPlacementArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalPlacementArea {
  const operation = transport.api.v1.placement.operations[":id"];
  return {
    async accept(request, options = {}) {
      return transport.readJson(
        transport.api.v1.placement.operations.$post(
          { json: request },
          ...signalRequestArgs(options.signal),
        ),
      );
    },
    async get({ operationId, signal }) {
      return transport.readJson(
        operation.$get(
          { param: { id: operationId } },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async recoverDraft({ operationId, signal }) {
      return transport.readJson(
        operation.draft.$get(
          { param: { id: operationId } },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async cancel({ operationId, signal }) {
      return transport.readJson(
        operation.cancel.$post(
          { param: { id: operationId } },
          ...signalRequestArgs(signal),
        ),
      );
    },
  };
}
