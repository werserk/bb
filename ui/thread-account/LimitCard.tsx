// U2: the limit card, plain content in a `chrome:"card"` composer banner
// (R1). It renders nothing unless the thread's last limit is current, so the
// host hides its pill.
import { useId, useRef } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AccountMenu, useAccountPick } from "./AccountPicker.js";
import { useThreadAccount } from "./hooks.js";
import { formatReset, type LimitCardView } from "./view.js";

const TONE: Record<LimitCardView["tone"], string> = {
  warning: "text-warning-text",
  destructive: "text-destructive-text",
};

function Body({ parts }: { parts: LimitCardView["body"] }) {
  const now = Date.now();
  return (
    <p className="text-xs text-muted-foreground">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : part.resetAt === null ? (
          <span key={index}>{formatReset(null, now)}</span>
        ) : (
          <time key={index} dateTime={new Date(part.resetAt).toISOString()}>
            {formatReset(part.resetAt, now)}
          </time>
        ),
      )}
    </p>
  );
}

function ThreadLimitCard({ threadId }: { threadId: string }) {
  const account = useThreadAccount(threadId);
  const pick = useAccountPick(account);
  const pendingRef = useRef(false);
  pendingRef.current = pick.pending !== null;
  const titleId = useId();
  const card = account.view.limit;
  if (card === null) return null;
  return (
    <section aria-labelledby={titleId} className="space-y-2 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Icon name={card.icon} className={cn("mt-0.5 size-4 shrink-0", TONE[card.tone])} aria-hidden />
        <h3 id={titleId} className={cn("min-w-0 flex-1 text-sm font-medium", TONE[card.tone])}>
          {card.title}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 size-7 max-md:pointer-coarse:size-9"
          aria-label={card.dismissLabel}
          onClick={() => account.store.dismiss(card.id)}
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </Button>
      </div>
      <Body parts={card.body} />
      <div>
        {card.action === "choose" ? (
          <AccountMenu
            account={account}
            choose={pick.choose}
            confirmPending={() => pendingRef.current}
            align="start"
            trigger={
              <Button size="sm" variant="outline" aria-haspopup="menu">
                {card.actionLabel}
                <Icon name="ChevronDown" className="size-3.5" aria-hidden />
              </Button>
            }
          />
        ) : (
          <Button size="sm" variant="outline" disabled={account.snapshot.busy} onClick={() => pick.choose({ kind: "auto" })}>
            {card.actionLabel}
          </Button>
        )}
      </div>
      {pick.dialog}
    </section>
  );
}

export function LimitCard() {
  const { scope } = useComposer();
  if (scope.kind !== "thread") return null;
  return <ThreadLimitCard threadId={scope.threadId} />;
}
