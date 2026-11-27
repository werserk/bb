// The account picker (a menu on the row's action button or the limit card's
// "Choose account") and its single confirm dialog (M4, M5, M6).
import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { UseThreadAccount } from "./hooks.js";
import {
  CODEX_PICKER_NOTE,
  confirmParts,
  isSamePolicy,
  pickerRows,
  type ConfirmParts,
  type PickTarget,
} from "./pick.js";

interface PendingConfirm {
  target: PickTarget;
  parts: ConfirmParts;
}

/** Pick handling shared by every picker of a thread: confirm, then `set`. */
export function useAccountPick(account: UseThreadAccount): {
  choose: (target: PickTarget) => void;
  pending: PendingConfirm | null;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const get = account.snapshot.get;
  const choose = (target: PickTarget) => {
    if (get === null || isSamePolicy(get, target)) return;
    const parts = confirmParts(get, target);
    if (parts !== null) {
      setPending({ target, parts });
      return;
    }
    void account.store.pick(target, false);
  };
  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
    >
      {pending === null ? null : (
        <DialogContent
          hideCloseButton
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{pending.parts.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {pending.parts.paragraphs.map((text, index) =>
              index === 0 ? (
                <DialogDescription key={text}>{text}</DialogDescription>
              ) : (
                <p key={text} className="text-sm text-muted-foreground">
                  {text}
                </p>
              ),
            )}
          </div>
          <DialogFooter className="flex-row items-center justify-end gap-2 sm:space-x-0">
            <Button ref={cancelRef} variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const { target, parts } = pending;
                setPending(null);
                void account.store.pick(target, parts.newSession);
              }}
            >
              {pending.parts.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return { choose, pending, dialog };
}

function RadioRow({
  checked,
  label,
  secondary,
  reasonId,
  usable,
  onPick,
}: {
  checked: boolean;
  label: string;
  secondary: string | null;
  reasonId?: string;
  usable: boolean;
  onPick: () => void;
}) {
  return (
    <DropdownMenuItem
      asChild
      onSelect={(event) => {
        if (!usable) {
          event.preventDefault();
          return;
        }
        onPick();
      }}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        aria-disabled={usable ? undefined : true}
        aria-describedby={usable ? undefined : reasonId}
        title={label}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-left max-md:pointer-coarse:min-h-9",
          !usable && "text-muted-foreground",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {checked ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {secondary === null ? null : (
          <span id={usable ? undefined : reasonId} className="shrink-0 text-muted-foreground">
            {secondary}
          </span>
        )}
      </button>
    </DropdownMenuItem>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{children}</div>;
}

export interface AccountMenuProps {
  account: UseThreadAccount;
  choose: (target: PickTarget) => void;
  /** Called before Radix moves focus back to the trigger on close. */
  confirmPending: () => boolean;
  trigger: ReactNode;
  align?: "start" | "end";
  /** Text above the lists: the row's details line. */
  header?: string;
}

/** A DropdownMenu with the picker content on the given trigger (asChild). */
export function AccountMenu({ account, choose, confirmPending, trigger, align = "end", header }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const { snapshot, view, store } = account;
  const get = snapshot.get;
  const rows = pickerRows(snapshot.accounts, Date.now());
  const named = get?.policy.mode === "named" ? get.policy : null;
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) store.pickerOpened();
        else store.pickerClosed();
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        mobileTitle="Account for this thread"
        className="w-72 max-w-[calc(100vw-2rem)]"
        onCloseAutoFocus={(event) => {
          if (confirmPending()) event.preventDefault();
        }}
      >
        {header === undefined ? null : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{header}</p>
        )}
        {view.state === "error" || view.state === "offline" ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              store.retry();
            }}
          >
            Retry
          </DropdownMenuItem>
        ) : null}
        {get === null ? null : (
          <>
            <Heading>Account for this thread</Heading>
            <div role="group" aria-label="Account" className="max-h-64 overflow-y-auto">
              <RadioRow
                checked={get.policy.mode === "auto"}
                label="Auto"
                secondary="Pool picks, fails over"
                usable
                onPick={() => choose({ kind: "auto" })}
              />
              {rows.map((row) => (
                <RadioRow
                  key={row.accountId}
                  checked={named?.accountId === row.accountId}
                  label={row.label}
                  secondary={row.secondary}
                  reasonId={`${baseId}-${row.accountId}`}
                  usable={row.usable || named?.accountId === row.accountId}
                  onPick={() => choose({ kind: "named", accountId: row.accountId, accountLabel: row.label })}
                />
              ))}
            </div>
            <DropdownMenuSeparator />
            <Heading>When this account hits its limit</Heading>
            <div role="group" aria-label="When this account hits its limit">
              {(
                [
                  ["fallback-auto", "Move to Auto"],
                  ["stop", "Stop until reset"],
                ] as const
              ).map(([onLimit, label]) => (
                <RadioRow
                  key={onLimit}
                  checked={named?.onLimit === onLimit}
                  label={label}
                  secondary={named === null ? "Pin an account first" : null}
                  reasonId={`${baseId}-onlimit-${onLimit}`}
                  usable={named !== null}
                  onPick={() => choose({ kind: "on-limit", onLimit })}
                />
              ))}
            </div>
            {get.provider === "codex" ? (
              <>
                <DropdownMenuSeparator />
                <p className="flex gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{CODEX_PICKER_NOTE}</span>
                </p>
              </>
            ) : null}
          </>
        )}
        <p role="status" aria-live="polite" className="px-2 text-xs text-muted-foreground empty:hidden">
          {snapshot.note ?? ""}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
