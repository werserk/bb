import { ContextRow, ContextRowIcon } from "@bb/shared-ui/context-row";
import { useComposerContextSource } from "../context/composer-context";
import { useId } from "react";
import { isSettledWorkflowAgentState } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { WorkflowWorkRowBody } from "@/components/thread/timeline/WorkflowWorkRowBody";
import { activityIconClass } from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackChevron,
  useDisclosureFocusHandoff,
  AnimatedDisclosureBody,
} from "@bb/shared-ui/prompt-stack-disclosure";
import { WorkflowPhaseStrip } from "@bb/shared-ui/workflow-progress";

function agentProgressLabel(workflow: TimelineWorkflowWorkRow): string | null {
  const agents = workflow.workflow?.agents ?? [];
  if (agents.length === 0) {
    return null;
  }
  const settled = agents.filter((agent) =>
    isSettledWorkflowAgentState(agent.state),
  ).length;
  return `${settled}/${agents.length} agents`;
}

interface ThreadWorkflowCardProps {
  workflow: TimelineWorkflowWorkRow;
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadWorkflowSummary({
  workflow,
}: {
  workflow: TimelineWorkflowWorkRow;
}) {
  const name = workflow.workflowName ?? workflow.description;
  const progress = agentProgressLabel(workflow);
  return (
    <>
      <Icon
        name="Workflow"
        className={activityIconClass("active", "size-3.5 shrink-0")}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span
          className="min-w-0 truncate font-medium text-foreground"
          title={name}
        >
          {name}
        </span>
        {progress ? (
          <span className="shrink-0 text-2xs tabular-nums text-subtle-foreground">
            {progress}
          </span>
        ) : null}
        <span className="shrink-0 text-2xs tabular-nums text-subtle-foreground">
          <LiveDurationText startedAt={workflow.startedAt} />
        </span>
      </span>
      {workflow.workflow ? (
        <WorkflowPhaseStrip
          progress={workflow.workflow}
          settled={false}
          className="w-16 shrink-0"
        />
      ) : null}
    </>
  );
}

export function ThreadWorkflowContextRow({
  workflow,
  isExpanded,
  onToggle,
}: ThreadWorkflowCardProps) {
  const id = useId();
  const name = workflow.workflowName ?? workflow.description;
  return (
    <>
      <ContextRow
        as="div"
        glyph={<ContextRowIcon name="Workflow" tone="working" />}
        actionInteractive
        title={name}
        subline={
          <>
            {agentProgressLabel(workflow)} ·{" "}
            <LiveDurationText startedAt={workflow.startedAt} />
          </>
        }
        action={
          <button
            type="button"
            aria-label={`Workflow: ${name}`}
            aria-expanded={isExpanded}
            aria-controls={id}
            onClick={onToggle}
          >
            {isExpanded ? "Hide details" : "Details"}
          </button>
        }
      />
      <div id={id} hidden={!isExpanded}>
        {isExpanded && (
          <WorkflowWorkRowBody row={workflow} size="base" collapsiblePhases />
        )}
      </div>
    </>
  );
}

export function ThreadWorkflowCard({
  workflow,
  isExpanded,
  onToggle,
}: ThreadWorkflowCardProps) {
  const compact = useComposerContextSource() !== null;
  const bodyId = useId();
  const toggleId = useId();
  const { triggerRef, collapseRef, onTriggerClick, onCollapseClick } =
    useDisclosureFocusHandoff(isExpanded, onToggle);
  if (workflow.status !== "pending") {
    return null;
  }
  const name = workflow.workflowName ?? workflow.description;
  if (compact)
    return (
      <PromptStackCard
        ariaLabel="Workflow"
        context={{ label: "Workflow", icon: "Workflow", group: "work" }}
      >
        <ThreadWorkflowContextRow
          workflow={workflow}
          isExpanded={isExpanded}
          onToggle={onToggle}
        />
      </PromptStackCard>
    );
  return (
    <PromptStackCard
      ariaLabel="Workflow"
      context={{
        label: "Workflow",
        icon: "Workflow",
        group: "work",
        kind: "working",
      }}
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <button
        ref={triggerRef}
        type="button"
        id={toggleId}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        aria-label={`Workflow: ${name}`}
        onClick={onTriggerClick}
        className={cn(
          PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
          PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
        )}
      >
        <ThreadWorkflowSummary workflow={workflow} />
        <PromptStackChevron isExpanded={isExpanded} />
      </button>
      <AnimatedDisclosureBody
        id={bodyId}
        labelledBy={toggleId}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel={`Collapse workflow ${name}`}
        collapseRef={collapseRef}
        onCollapse={onCollapseClick}
      >
        <WorkflowWorkRowBody row={workflow} size="base" collapsiblePhases />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
