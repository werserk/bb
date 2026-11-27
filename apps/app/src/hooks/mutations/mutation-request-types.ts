import { createClientSubmissionId } from "@bb/domain";
import type {
  EditMessageRequest,
  SendMessageRequest,
} from "@bb/server-contract";

export interface SendThreadMessageMutationRequest extends SendMessageRequest {
  id: string;
}

export interface EditMessageMutationRequest extends EditMessageRequest {
  id: string;
}

const preparedSends = new WeakMap<
  SendThreadMessageMutationRequest,
  SendThreadMessageMutationRequest & { clientSubmissionId: string }
>();
export function prepareSendRequest(request: SendThreadMessageMutationRequest) {
  let prepared = preparedSends.get(request);
  if (!prepared) {
    prepared = {
      ...request,
      clientSubmissionId: request.clientSubmissionId ?? createClientSubmissionId(),
    };
    preparedSends.set(request, prepared);
  }
  return prepared;
}
