import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
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

function ContributionRow({
  item,
  pin,
}: {
  item: HeaderContribution;
  pin: ReactNode;
}) {
  const compact = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const targets = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (compact && open)
      targets.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [compact, open]);
  const row = (
    <div className="flex items-center gap-1">
      <DropdownMenuItem
        className="min-w-0 flex-1"
        disabled={item.action.disabled}
        onSelect={() => void item.action.run()}
        onKeyDown={(event) => {
          if (item.menuActions?.length && event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={item.action.icon} aria-hidden />
        <span className="truncate">{item.label}</span>
      </DropdownMenuItem>
      {item.menuActions?.length ? (
        compact ? (
          <DropdownMenuItem
            asChild
            className="size-6 shrink-0 justify-center p-0"
            aria-label="Choose Open target"
            aria-haspopup="menu"
            aria-expanded={open}
            onSelect={(event) => {
              event.preventDefault();
              setOpen(!open);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <button
              type="button"
              ref={(element) => {
                trigger.current = element;
              }}
            >
              <Icon name="ChevronRight" aria-hidden />
            </button>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSubTrigger
            ref={(element) => {
              trigger.current = element;
            }}
            aria-label="Choose Open target"
            className="size-6 shrink-0 justify-center gap-0 p-0"
          />
        )
      ) : null}
      {pin}
    </div>
  );
  const choices = item.menuActions?.map((action) => (
    <DropdownMenuItem key={action.id} onSelect={() => void action.run()}>
      {action.label}
    </DropdownMenuItem>
  ));
  if (!item.menuActions?.length) return row;
  if (compact)
    return (
      <>
        {row}
        {open ? (
          <div
            ref={targets}
            role="menu"
            aria-label="Open workspace in"
            className="ml-6 border-l pl-2"
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="menuitem"]',
                  ),
                );
                const index = items.findIndex(
                  (element) => element === document.activeElement,
                );
                items[
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                    items.length
                ]?.focus();
              }
            }}
          >
            {choices}
          </div>
        ) : null}
      </>
    );
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      {row}
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
          {choices}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
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
            {items.map((item) => {
              const pinLabel = isPinned ? "Unpin from header" : "Pin to header";
              return (
                <ContributionRow
                  key={item.key}
                  item={item}
                  pin={
                    <DropdownMenuItem
                      asChild
                      className="size-6 shrink-0 justify-center p-0"
                      aria-label={`${pinLabel}: ${item.label}`}
                      onSelect={(event) => {
                        event.preventDefault();
                        pendingFocus.current = item.key;
                        onPinChange(item.key, !isPinned);
                      }}
                    >
                      <button
                        type="button"
                        ref={(button) => {
                          if (button) pinButtons.current.set(item.key, button);
                          else pinButtons.current.delete(item.key);
                        }}
                      >
                        <Icon
                          name="Pin"
                          className={isPinned ? "fill-current" : undefined}
                          aria-hidden
                        />
                      </button>
                    </DropdownMenuItem>
                  }
                />
              );
            })}
            <DropdownMenuSeparator />
          </Fragment>
        ),
      )}
    </>
  );
}
