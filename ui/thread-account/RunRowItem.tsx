// The account chip in the composer's run row, after Run on (tasks 5.1-5.3).
// An open thread's chip is a second door to its U1 menu and store; a new
// thread's chip holds a draft choice that the send carries to the pool.
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
} from "react";
import { useRealtime, useRpc, type JsonValue } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { pooledProvider, type PoolProvider } from "../../src/contracts.js";
import { ACCOUNT_POOL_ACCOUNTS_CHANGED } from "../../src/realtime.js";
import type { accountPoolRpcContract } from "../../src/rpc.js";
import { TONE_TEXT } from "./AccountCardRow.js";
import { AccountMenu, useAccountPick } from "./AccountPicker.js";
import { DRAFT_TITLE, DraftAccountStore, draftView, type LoadAccounts, type SetSubmission } from "./draft.js";
import { useThreadAccount, type PickerAccount } from "./hooks.js";
import type { ExperimentalComposerRunRowItemProps } from "./run-row-slot.js";
import type { ThreadAccountView } from "./view.js";

export const RUN_ROW_ITEM_ID = "thread-account";
/** Row items follow Run on; the lowest order comes first among them. */
export const RUN_ROW_ITEM_ORDER = 10;

const AccountChip = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { view: ThreadAccountView; compact: boolean }
>(function AccountChip({ view, compact, className, ...props }, ref) {
  const tone = TONE_TEXT[view.tone];
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Account: ${view.label}`}
      title={view.details}
      className={cn(
        "flex h-7 min-w-0 max-w-48 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      <span className="relative inline-flex shrink-0">
        <Icon name={view.icon} className={cn("size-3.5", view.dot ? "text-muted-foreground" : tone)} aria-hidden />
        {view.dot ? <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warning" /> : null}
      </span>
      {compact ? null : (
        <>
          <span className={cn("min-w-0 truncate", tone)}>{view.label}</span>
          <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
        </>
      )}
    </button>
  );
});

function AccountChipMenu({
  account,
  compact,
  title,
  codexNote,
}: {
  account: PickerAccount;
  compact: boolean;
  title?: string;
  codexNote?: boolean;
}) {
  const pick = useAccountPick(account);
  const pendingRef = useRef(false);
  pendingRef.current = pick.pending !== null;
  const { view, snapshot } = account;
  if (view.state === "hidden") return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AccountMenu
        account={account}
        choose={pick.choose}
        confirmPending={() => pendingRef.current}
        header={view.details}
        title={title}
        codexNote={codexNote}
        align="start"
        trigger={<AccountChip view={view} compact={compact} />}
      />
      {pick.dialog}
      {compact || snapshot.note === null ? null : (
        <span className="max-w-40 truncate text-xs text-muted-foreground" title={snapshot.note}>
          {snapshot.note}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {snapshot.note ?? ""}
      </span>
    </span>
  );
}

function OpenThreadAccount({ threadId, compact }: { threadId: string; compact: boolean }) {
  return <AccountChipMenu account={useThreadAccount(threadId)} compact={compact} />;
}

function DraftAccountChip({
  provider,
  compact,
  setSubmission,
}: {
  provider: PoolProvider;
  compact: boolean;
  setSubmission: (data: JsonValue | null) => boolean;
}) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  // The policy object has no undefined members, so it is plain JSON.
  const submit: SetSubmission = (data) => setSubmission(data as JsonValue | null);
  const load: LoadAccounts = () => rpc.call("account.list", null);
  const [store] = useState(() => new DraftAccountStore(provider, submit, load));
  store.setSources(submit, load);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => store.onAccountsChanged());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const account: PickerAccount = { store, snapshot, view: draftView(snapshot, Date.now()) };
  return <AccountChipMenu account={account} compact={compact} title={DRAFT_TITLE} codexNote={false} />;
}

export function ThreadAccountRunRowItem({ scope, compact, setSubmission }: ExperimentalComposerRunRowItemProps) {
  if (scope.kind === "thread") return <OpenThreadAccount threadId={scope.threadId} compact={compact} />;
  const provider = scope.providerId === null ? null : pooledProvider(scope.providerId);
  // Hidden for a provider the pool does not route, and where core cannot
  // carry the choice: the chip never shows an account the send would not use.
  if (provider === null || setSubmission === undefined) return null;
  // A new key on a project or provider change starts a fresh draft on Auto.
  return (
    <DraftAccountChip
      key={`${scope.projectId ?? ""}\u0000${scope.providerId}`}
      provider={provider}
      compact={compact}
      setSubmission={setSubmission}
    />
  );
}
