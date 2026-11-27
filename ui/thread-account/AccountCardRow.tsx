// U1: the thread's account as a thread context card row. The label is plain
// text; the row's `action` button is the only picker trigger (M5).
import { forwardRef, useRef, type ComponentPropsWithoutRef } from "react";
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  type ExperimentalThreadContextCardProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AccountMenu, useAccountPick } from "./AccountPicker.js";
import { useThreadAccount } from "./hooks.js";
import type { Tone } from "./view.js";

export const TONE_TEXT: Record<Tone, string> = {
  muted: "text-muted-foreground",
  default: "text-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive-text",
};

const PickerTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & { label: string }>(
  function PickerTrigger({ label, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={`Change account for this thread (${label})`}
        className={cn(
          "flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9",
          className,
        )}
        {...props}
      >
        <Icon name="ChevronDown" className="size-3.5" aria-hidden />
      </button>
    );
  },
);

export function AccountCardRow({ threadId }: ExperimentalThreadContextCardProps) {
  const account = useThreadAccount(threadId);
  const { view, snapshot } = account;
  const pick = useAccountPick(account);
  const pendingRef = useRef(false);
  pendingRef.current = pick.pending !== null;
  if (view.state === "hidden") return null;

  const coloured = view.dot || view.tone === "warning" || view.tone === "destructive";
  const leading = coloured ? (
    <span className="relative inline-flex">
      <Icon
        name={view.icon}
        className={cn("size-3.5", view.dot ? "text-muted-foreground" : TONE_TEXT[view.tone])}
        aria-hidden
      />
      {view.dot ? (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-warning" />
      ) : null}
    </span>
  ) : undefined;
  const rawError =
    view.state === "error" && typeof snapshot.getError?.message === "string"
      ? ` (${snapshot.getError.message})`
      : "";

  return (
    <ThreadContextCardRow
      icon={coloured ? undefined : view.icon}
      leading={leading}
      label={
        <span className={TONE_TEXT[view.tone]}>
          {view.label}
          {view.dot ? <span className="sr-only"> (limit)</span> : null}
        </span>
      }
      title={view.details + rawError}
      trailing={
        snapshot.note === null ? undefined : (
          <span className="max-w-28 truncate" title={snapshot.note}>
            {snapshot.note}
          </span>
        )
      }
      action={
        <>
          <AccountMenu
            account={account}
            choose={pick.choose}
            confirmPending={() => pendingRef.current}
            header={view.details}
            trigger={<PickerTrigger label={view.label} />}
          />
          {pick.dialog}
          <span role="status" aria-live="polite" className="sr-only">
            {snapshot.note ?? ""}
          </span>
        </>
      }
    />
  );
}
