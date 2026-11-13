import { Fragment } from "react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import type { PluginBoundThreadAction } from "@get-bb/plugin-sdk";

export interface HeaderContribution {
  key: string;
  label: string;
  action: PluginBoundThreadAction;
}

export function ThreadHeaderContributionsMenu({
  pinned,
  more,
  onToggle,
}: {
  pinned: HeaderContribution[];
  more: HeaderContribution[];
  onToggle: (key: string) => void;
}) {
  return (
    <>
      {[
        { label: "In header", items: pinned, isPinned: true },
        { label: "More actions", items: more, isPinned: false },
      ].map(({ label, items, isPinned }) =>
        items.length === 0 ? null : (
          <Fragment key={label}>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {items.map((item) => {
              const pinLabel = isPinned ? "Unpin from header" : "Pin to header";
              return (
                <div key={item.key} className="flex items-center gap-1">
                  <DropdownMenuItem
                    className="min-w-0 flex-1"
                    disabled={item.action.disabled}
                    onSelect={() => void item.action.run()}
                  >
                    <Icon name={item.action.icon} aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    asChild
                    className="size-6 shrink-0 justify-center p-0"
                    aria-label={`${pinLabel}: ${item.label}`}
                    title={pinLabel}
                    onSelect={(event) => {
                      event.preventDefault();
                      onToggle(item.key);
                    }}
                  >
                    <button type="button">
                      <Icon
                        name="Pin"
                        className={isPinned ? "fill-current" : undefined}
                        aria-hidden
                      />
                    </button>
                  </DropdownMenuItem>
                </div>
              );
            })}
            <DropdownMenuSeparator />
          </Fragment>
        ),
      )}
    </>
  );
}
