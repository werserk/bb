import { Fragment, useLayoutEffect, useRef } from "react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import type { PluginBoundThreadAction } from "@get-bb/plugin-sdk";

export interface HeaderMenuAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

export interface HeaderContribution {
  key: string;
  label: string;
  action: PluginBoundThreadAction;
  menuActions?: readonly HeaderMenuAction[];
}

export function ThreadHeaderContributionsMenu({
  pinned,
  more,
  onPinChange,
}: {
  pinned: HeaderContribution[];
  more: HeaderContribution[];
  onPinChange: (key: string, pinned: boolean) => void;
}) {
  const pinButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    pinButtons.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });
  return (
    <>
      {[
        { label: "In header", items: pinned, isPinned: true },
        { label: "More actions", items: more, isPinned: false },
      ].map(({ label, items, isPinned }) =>
        items.length === 0 ? null : (
          <Fragment key={label}>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {items.flatMap((item) => {
              const pinLabel = isPinned ? "Unpin from header" : "Pin to header";
              const actions = item.menuActions ?? [
                { id: "default", label: item.label, run: item.action.run },
              ];
              return actions.map((action) => {
                const rowKey = `${item.key}/${action.id}`;
                return (
                  <div key={rowKey} className="flex items-center gap-1">
                    <DropdownMenuItem
                      className="min-w-0 flex-1"
                      disabled={item.action.disabled}
                      onSelect={() => void action.run()}
                    >
                      <Icon name={item.action.icon} aria-hidden />
                      <span className="truncate">{action.label}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      asChild
                      className="size-6 shrink-0 justify-center p-0"
                      aria-label={`${pinLabel}: ${action.label}`}
                      title={pinLabel}
                      onSelect={(event) => {
                        event.preventDefault();
                        pendingFocus.current = rowKey;
                        onPinChange(item.key, !isPinned);
                      }}
                    >
                      <button
                        type="button"
                        ref={(button) => {
                          if (button) pinButtons.current.set(rowKey, button);
                          else pinButtons.current.delete(rowKey);
                        }}
                      >
                        <Icon
                          name="Pin"
                          className={isPinned ? "fill-current" : undefined}
                          aria-hidden
                        />
                      </button>
                    </DropdownMenuItem>
                  </div>
                );
              });
            })}
            <DropdownMenuSeparator />
          </Fragment>
        ),
      )}
    </>
  );
}
