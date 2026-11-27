import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "@bb/shared-ui/option-display";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import type { ComponentType, ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { formatRelativeTime } from "@/lib/relative-time";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";
import type { RunOnChipView } from "./model";
import { RUN_ON_TITLE, RunOnTriggerLabel } from "./RunOnGroups";

export interface RunOnThreadView {
  threadId: string;
  pluginId: string;
  environmentProviderId: string;
  chip: RunOnChipView;
  agentHostId: string;

  agentLastSeenAt: number | null;
  workspaceHostId: string | null;
  detail: string | null;
  issue: string | null;
  ThreadActions: ComponentType<{ threadId: string }> | null;
}

function Row({
  icon,
  label,
  value,
  connected,
  trailing,
}: {
  icon: "Server" | "Laptop";
  label: string;
  value: string;
  connected: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-xs">
      <MachineStatusDot connected={connected} />
      <Icon
        name={icon}
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="shrink-0">{label}</span>
      <span className="ml-auto min-w-0 truncate pl-3 text-right">{value}</span>
      {trailing}
    </div>
  );
}

function OfflineNote({
  text,
  hostId,
  onOpenMachine,
}: {
  text: string;
  hostId: string;
  onOpenMachine: (hostId: string) => void;
}) {
  return (
    <div className="mt-2 text-2xs">
      <p className="text-warning-text">{text}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-7 text-xs"
        onClick={() => onOpenMachine(hostId)}
      >
        Open machines
      </Button>
    </div>
  );
}

export function RunOnThreadPopover({ view }: { view: RunOnThreadView }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();
  const { chip, ThreadActions } = view;
  const openMachine = (hostId: string) => {
    setOpen(false);
    void navigate(getSettingsMachineRoutePath(hostId));
  };
  const lastSeen =
    view.agentLastSeenAt === null
      ? ""
      : ` Last seen ${formatRelativeTime({ timestamp: view.agentLastSeenAt, now })}.`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setNow(Date.now());
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${RUN_ON_TITLE}: ${chip.agentName} on ${chip.workspaceName ?? "unknown workspace"}`}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            OPTION_MUTED_CLASS_NAME,
            LIST_HOVER_TRANSITION,
            "h-6 min-w-min shrink px-1 text-xs max-md:pointer-coarse:h-11",
          )}
        >
          <RunOnTriggerLabel chip={chip} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="This thread runs on"
        mobileTitle={RUN_ON_TITLE}
        className="w-80 max-w-[calc(100vw-1rem)] p-3 max-md:w-full"
      >
        <div className="mb-1 text-2xs font-medium text-muted-foreground">
          This thread runs on
        </div>
        <Row
          icon="Server"
          label="Agent"
          value={chip.agentName}
          connected={!chip.agentOffline}
          trailing={
            <Icon
              name="Lock"
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-label="Fixed for this thread"
            />
          }
        />
        <Row
          icon="Laptop"
          label="Workspace"
          value={chip.workspaceName ?? "Unknown"}
          connected={!chip.workspaceOffline && chip.workspaceName !== null}
        />
        {view.detail ? (
          <p className="mt-1 break-all text-2xs text-muted-foreground">
            {view.detail}
          </p>
        ) : null}
        {view.issue ? (
          <p className="mt-2 text-2xs text-warning-text">{view.issue}</p>
        ) : null}
        {chip.agentOffline ? (
          <OfflineNote
            text={`Worker ${chip.agentName} is offline.${lastSeen} The next turn waits until it reconnects.`}
            hostId={view.agentHostId}
            onOpenMachine={openMachine}
          />
        ) : chip.workspaceOffline && view.workspaceHostId !== null ? (
          <OfflineNote
            text={`Workspace ${chip.workspaceName ?? ""} is offline. The agent cannot read the workspace.`}
            hostId={view.workspaceHostId}
            onOpenMachine={openMachine}
          />
        ) : null}
        {ThreadActions ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <PluginSlotMount
              pluginId={view.pluginId}
              slotKind="runOnProvider"
              slotId={view.environmentProviderId}
              instanceId={`thread-actions:${view.threadId}`}
              crashFallback={null}
            >
              <ThreadActions threadId={view.threadId} />
            </PluginSlotMount>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
