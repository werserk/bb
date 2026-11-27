import { useMemo, type ReactNode } from "react";
import { PendingSendPresentationContext } from "./pending-send-presentation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { createClientSubmissionId } from "@bb/domain";
import { useSendThreadMessage } from "@/hooks/mutations/thread-runtime-mutations";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  retryPendingSendRecovery,
  refreshPendingSends,
  usePendingSendOwner,
  usePendingSendEntries,
  usePendingSendSnapshot,
} from "@/hooks/cache-owners/pending-send-owner";

export function PendingSendControls({ threadId }: { threadId: string }) {
  const client = useQueryClient();
  const snapshot = usePendingSendSnapshot(client);
  const status = snapshot.recoveryStatus,
    journal = snapshot.journal;
  const entries = snapshot.entries.filter(
    (entry) => entry.threadId === threadId,
  );
  const identityUnavailable = snapshot.identityUnavailable;
  return (
    <>
      {status === "waiting" ? (
        <div role="status" className="text-muted-foreground text-sm">
          Restoring pending sends…{" "}
          <Button variant="ghost" size="sm" onClick={() => journal?.refresh()}>
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={() => journal?.hide()}>
            Hide
          </Button>
        </div>
      ) : null}
      {(identityUnavailable || entries.length > 0) &&
      (status === "unavailable" || status === "unsaved") ? (
        <div role="status" className="text-muted-foreground text-sm">
          {status === "unsaved"
            ? "Not saved for reload"
            : "Reload recovery unavailable"}
          {identityUnavailable ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void retryPendingSendRecovery(client).catch(() => {});
              }}
            >
              Refresh
            </Button>
          ) : null}
        </div>
      ) : null}
      {entries.length > 0 && status === "owned" ? (
        <div className="text-muted-foreground text-sm">
          Kept in this tab until delivery is confirmed. Closing this tab may
          discard unconfirmed content.
        </div>
      ) : null}
    </>
  );
}

export function PendingSendPresentation({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const snapshot = usePendingSendEntries(client);
  const value = useMemo(() => {
    const entries = new Map(
      snapshot
        .filter(
          (entry) => entry.threadId === threadId && entry.state !== "queued",
        )
        .map((entry) => [entry.row.id, entry]),
    );
    return (rowId: string) => {
      const entry = entries.get(rowId);
      return entry ? <PendingSendEntryControls entry={entry} /> : null;
    };
  }, [snapshot, threadId]);
  return (
    <PendingSendPresentationContext.Provider value={value}>
      {children}
    </PendingSendPresentationContext.Provider>
  );
}
function PendingSendEntryControls({
  entry,
}: {
  entry: import("@bb/client-core").PendingSend;
}) {
  const client = useQueryClient(),
    owner = usePendingSendOwner(client),
    mutation = useSendThreadMessage(),
    threadId = entry.threadId;
  const label =
    entry.state === "sending"
      ? "Sending…"
      : entry.state === "sent"
        ? "Sent"
        : entry.state === "failed"
          ? "Not sent"
          : entry.state === "unresolved"
            ? "Delivery unresolved"
            : "Delivery unconfirmed";
  return (
    <div
      key={entry.id}
      data-pending-send-id={entry.id}
      role="status"
      className="text-muted-foreground text-sm"
    >
      {label}
      {entry.state === "failed" && entry.error ? `: ${entry.error}` : null}
      {entry.state === "failed" && entry.request ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const request = entry.request;
            if (!request) return;
            const id = createClientSubmissionId();
            const retry = {
              ...request,
              id: threadId,
              clientSubmissionId: id,
            };
            if (
              !owner.replaceFailed(threadId, entry.id, {
                ...entry,
                id,
                row: { ...entry.row, id: `pending-send-${id}` },
                request: retry,
                submissionIds: [id],
                queueIds: [],
                queueRows: [],
                sequence: 0,
                state: "sending",
                error: undefined,
              })
            )
              return;
            void mutation.mutateAsync(retry).catch(() => {});
          }}
        >
          Retry
        </Button>
      ) : null}
      {entry.state === "failed" ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => owner.hide(threadId, entry.id)}
        >
          Hide
        </Button>
      ) : null}
      {entry.state === "unconfirmed" || entry.state === "unresolved" ? (
        <>
          {entry.state === "unconfirmed" && entry.request ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const request = entry.request;
                if (!request || !owner.resend(threadId, entry.id)) return;
                void mutation
                  .mutateAsync({ ...request, id: threadId })
                  .catch(() => {});
              }}
            >
              Resend
            </Button>
          ) : null}
          {entry.state === "unconfirmed" &&
          !entry.request &&
          entry.queueIds.length === 0 ? (
            <>
              {" "}
              <span>Resend not kept after reload</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copyToClipboardWithToast(entry.row.text);
                }}
              >
                Copy text
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refreshPendingSends(client, threadId).catch(() => {});
            }}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => owner.hide(threadId, entry.id)}
          >
            Hide
          </Button>
        </>
      ) : null}
    </div>
  );
}
