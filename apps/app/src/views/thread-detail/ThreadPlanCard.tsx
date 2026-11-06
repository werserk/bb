import { useMemo, useState } from "react";
import type { ThreadTimelinePendingTodos } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";
import { latestPlanTurn, threadPlanState } from "./thread-plan-state";

export function ThreadPlanCard({
  pendingTodos,
  rows,
  waitingForOwner,
}: {
  pendingTodos: ThreadTimelinePendingTodos | null;
  rows: readonly TimelineRow[];
  waitingForOwner: boolean;
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
    <aside
      className="order-first ml-auto w-full min-w-0 max-w-sm shrink-0 p-3 @min-[880px]/thread-chat:order-last @min-[880px]/thread-chat:w-80 @min-[880px]/thread-chat:overflow-y-auto"
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
    </aside>
  );
}
