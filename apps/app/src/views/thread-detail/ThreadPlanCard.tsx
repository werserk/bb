import { useMemo, useState } from "react";
import type { ThreadTimelinePendingTodos } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { cn } from "@bb/shared-ui/lib/utils";
import { latestPlanTurn, threadPlanState } from "./thread-plan-state";

export function ThreadPlanCard({
  pendingTodos,
  rows,
  waitingForOwner,
  placement = "floating",
}: {
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: readonly TimelineRow[];
  waitingForOwner: boolean;
  placement?: "floating" | "stacked";
}) {
  const latestTurn = useMemo(() => latestPlanTurn(rows), [rows]);
  const state = pendingTodos
    ? threadPlanState(pendingTodos, latestTurn, waitingForOwner)
    : null;
  const disclosureKey = state?.autoCollapse ? state.state : "live";
  const [disclosure, setDisclosure] = useState({
    key: disclosureKey,
    expanded: !state?.autoCollapse,
  });
  if (disclosure.key !== disclosureKey) {
    setDisclosure({ key: disclosureKey, expanded: !state?.autoCollapse });
  }
  const expanded =
    disclosure.key === disclosureKey
      ? disclosure.expanded
      : !state?.autoCollapse;
  if (!pendingTodos?.items.length || !state) return null;
  return (
    <div
      className={cn(
        "pointer-events-none flex shrink-0 justify-end [&>section]:pointer-events-auto",
        placement === "floating"
          ? "absolute right-3 top-3 z-10 max-w-[calc(100%-1.5rem)]"
          : "max-w-full",
      )}
      data-thread-plan=""
    >
      <ThreadTodoCard
        pendingTodos={pendingTodos}
        state={state.state}
        isExpanded={expanded}
        onToggle={() =>
          setDisclosure({ key: disclosureKey, expanded: !expanded })
        }
      />
    </div>
  );
}
