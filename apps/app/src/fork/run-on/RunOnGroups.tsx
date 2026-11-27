import { Icon } from "@bb/shared-ui/icon";
import {
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@bb/shared-ui/command";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_DOT_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  chipText,
  type RunOnChipView,
  type RunOnGroupView,
  type RunOnRowView,
} from "./model";

export const RUN_ON_TITLE = "Run on";

export interface RunOnPickerModel {
  groups: readonly RunOnGroupView[];

  registeredProviderIds: ReadonlySet<string>;

  selectedValue: string | null;

  chip: RunOnChipView | null;

  footer: string | null;
  onSelect(row: RunOnRowView): void;
}

function AgentArrow() {
  return (
    <>
      <span aria-hidden className="shrink-0 text-muted-foreground">
        →
      </span>
      <span className="sr-only">on</span>
    </>
  );
}

export function RunOnTriggerLabel({ chip }: { chip: RunOnChipView }) {
  const text = chipText(chip);
  return (
    <span
      data-run-on-chip=""
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-hidden",
        chip.warning && "text-warning-text",
      )}
    >
      <Icon
        name="Server"
        className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
      />
      <span className="min-w-[3ch] truncate">{text.agent}</span>
      <AgentArrow />
      <span className="min-w-[3ch] truncate">{text.workspace}</span>
    </span>
  );
}

export function RunOnLocalHeading() {
  return (
    <div className="px-2 pt-2 text-2xs font-medium text-muted-foreground">
      <div className="mb-1.5 text-foreground/80">{RUN_ON_TITLE}</div>
      <div>
        Local{" "}
        <span className="font-normal">· agent and files on one machine</span>
      </div>
    </div>
  );
}

function rowStatus(row: RunOnRowView, now: number): string | null {
  if (row.unavailableReason === null) return null;
  if (row.lastSeenAt !== null) {
    return `last seen ${formatRelativeTime({ timestamp: row.lastSeenAt, now })}`;
  }
  return row.unavailableReason;
}

function RunOnRow({
  row,
  selected,
  now,
  onSelect,
}: {
  row: RunOnRowView;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const disabled = row.unavailableReason !== null;
  const status = rowStatus(row, now);
  return (
    <CommandItem
      value={row.value}
      disabled={disabled}
      aria-current={selected ? "true" : undefined}
      title={row.unavailableReason ?? undefined}
      onSelect={() => {
        if (!disabled) onSelect();
      }}
      className={cn(
        "flex items-center gap-3 py-[0.3125rem] text-xs max-md:pointer-coarse:py-2",
        LIST_HOVER_TRANSITION,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <MachineStatusDot
          connected={row.agentConnected}
          className={COARSE_POINTER_DOT_SIZE_CLASS}
        />
        <Icon
          name="Server"
          className={cn(
            "text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="min-w-0 truncate">{row.agentName}</span>
        <AgentArrow />
        <span className="min-w-0 truncate">{row.workspaceName}</span>
      </span>
      {status !== null ? (
        <span className="ml-auto shrink-0 truncate pl-2 text-2xs text-muted-foreground">
          {status}
        </span>
      ) : null}
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </CommandItem>
  );
}

function GroupStateRow({ value, text }: { value: string; text: string }) {
  return (
    <CommandItem
      value={value}
      disabled
      className="whitespace-normal break-words text-xs text-muted-foreground"
    >
      {text}
    </CommandItem>
  );
}

export function RunOnGroups({
  model,
  now,
  onClose,
}: {
  model: RunOnPickerModel;
  now: number;
  onClose: () => void;
}) {
  return (
    <>
      {model.groups.map((group) => (
        <div key={group.providerId} className="contents">
          <CommandSeparator className="mx-0 shrink-0" />
          <CommandGroup
            className="shrink-0"
            heading={
              <span className="flex min-w-0 items-center gap-1">
                <span className="shrink-0">{group.title}</span>
                {group.description ? (
                  <span className="min-w-0 truncate font-normal">
                    · {group.description}
                  </span>
                ) : null}
              </span>
            }
          >
            {group.status === "loading" && group.rows.length === 0 ? (
              <GroupStateRow
                value={`runon-loading:${group.providerId}`}
                text="Loading…"
              />
            ) : null}
            {group.error !== null ? (
              <GroupStateRow
                value={`runon-error:${group.providerId}`}
                text={group.error}
              />
            ) : null}
            {group.status === "ready" && group.rows.length === 0 ? (
              <GroupStateRow
                value={`runon-empty:${group.providerId}`}
                text="No workspaces for this project"
              />
            ) : null}
            {group.rows.map((row) => (
              <RunOnRow
                key={row.value}
                row={row}
                now={now}
                selected={model.selectedValue === row.value}
                onSelect={() => {
                  model.onSelect(row);
                  onClose();
                }}
              />
            ))}
          </CommandGroup>
        </div>
      ))}
    </>
  );
}

export function RunOnFooter({ model }: { model: RunOnPickerModel }) {
  if (model.footer === null) return null;
  return (
    <div
      data-run-on-footer=""
      className="shrink-0 truncate border-t border-border px-3 py-2 text-2xs text-muted-foreground"
      title={model.footer}
    >
      {model.footer}
    </div>
  );
}
