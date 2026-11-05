import { useAtomValue } from "jotai";
import {
  maximizedPaneIdAtom,
  multiPaneSplitLayoutAtom,
} from "@/lib/split-layout/atoms";
import { listPanes } from "@/lib/split-layout/ops";
import { useSplitWorkspaceActive } from "@/hooks/useSplitWorkspaceActive";
import {
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk";
import {
  CORE_THREAD_CONTEXT_OWNER,
  ThreadContextSegmentMount,
  threadContextSegmentKey,
  threadContextSegmentMountKey,
  useThreadContextSegments,
  type CoreThreadContextSegment,
  type ThreadContextSegmentEntry,
  type ThreadContextSegmentPart,
} from "@/components/plugin/PluginThreadContextSegments";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import {
  machineRemovalDescriptions,
  machineRemovalLabels,
  type MachineRemovalStatus,
} from "@/lib/machine-removal-display";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { NavLink } from "react-router-dom";
import type {
  EnvironmentStatus,
  PendingInteraction,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_CONTEXT_BANNER_COLLAPSED_HEIGHT,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
} from "@bb/shared-ui/activity-row-styles";
import { ThreadPendingInteractionBanners } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import { cn } from "@bb/shared-ui/lib/utils";
import { useThreadContextKind } from "@/components/plugin/PluginThreadContextCard";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  AnimatedBody,
  AnimatedDisclosureBody,
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackCollapseRow,
  PromptStackCountSlot,
  SectionToggleButton,
  useDisclosureFocusHandoff,
} from "@bb/shared-ui/prompt-stack-disclosure";
import {
  BannerActionSlot,
  PromptBannerActionButton,
} from "@bb/shared-ui/prompt-banner-actions";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";
import { childThreadNoun } from "@/lib/child-thread-copy";
import { SIDEBAR_WORKING_STATUS_COLOR_CLASS } from "@bb/shared-ui/sidebar-row-classes";

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork";
}

interface ThreadPromptChildThreadItem {
  id: string;
  title: string;
  href: string;
  hasPendingInteraction: boolean;
}

export interface ChildThreadQuestion {
  childThreadId: string;
  childTitle: string;
  href: string;
  interaction: PendingInteraction;
}

export interface ThreadPromptChildThreadsSection {
  items: readonly ThreadPromptChildThreadItem[];
  pendingInteractions: readonly ChildThreadQuestion[];
}

export interface ThreadPromptArchivedSection {
  archivedAt: number;
  onUnarchive?: () => void;
  unarchivePending?: boolean;
}

export interface ThreadPromptEnvironmentGoneSection {
  status: Extract<EnvironmentStatus, "destroyed"> | MachineRemovalStatus;
  onRestore?: () => void;
  restorePending?: boolean;
}

const THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES: ReadonlySet<ThreadRuntimeDisplayStatus> =
  new Set(["active", "provisioning", "starting", "waiting-for-host"]);

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES.has(status);
}

export interface CoreThreadContext {
  parentThread: ThreadPromptParentThreadSection | null;
}

interface ThreadPromptContextBannerProps {
  input: ExperimentalThreadContextSegmentInput;
  core: CoreThreadContext;
  archivedSection: ThreadPromptArchivedSection | null;
  environmentGoneSection: ThreadPromptEnvironmentGoneSection | null;
  expandedSegment: string | null;
  onToggleSegment: (key: string) => void;
}

const ARCHIVED_THREAD_STATUS_LABEL = "Thread is archived";
const ENVIRONMENT_GONE_STATUS_COPY: Record<
  ThreadPromptEnvironmentGoneSection["status"],
  { description: string; label: string }
> = {
  destroyed: {
    description:
      "Environment unavailable. You can still view this thread’s history.",
    label: "Environment unavailable",
  },
  removed: {
    label: machineRemovalLabels.removed,
    description: machineRemovalDescriptions.removed,
  },
  removing: {
    label: machineRemovalLabels.removing,
    description: machineRemovalDescriptions.removing,
  },
  "cleanup-failed": {
    label: machineRemovalLabels["cleanup-failed"],
    description: machineRemovalDescriptions["cleanup-failed"],
  },
};

const SECTION_IDS = {
  parentThread: {
    toggle: "thread-prompt-banner-parent-thread-toggle",
    body: "thread-prompt-banner-parent-thread-body",
  },
  childThreads: {
    toggle: "thread-prompt-banner-child-threads-toggle",
    body: "thread-prompt-banner-child-threads-body",
  },
  status: {
    toggle: "thread-prompt-banner-status-toggle",
    body: "thread-prompt-banner-status-body",
  },
} as const;

const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string }
> = {
  parent: {
    verb: "Parent",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
  },
};

const PARENT_SECTION_ICON: Record<
  ThreadPromptParentThreadSection["relationship"],
  IconName
> = {
  parent: "UserRound",
  fork: "Fork",
};

function useParentSectionAriaLabel(
  section: ThreadPromptParentThreadSection,
): string {
  const parentThreadTitle = useThreadTitleDisplayText(
    section.parentThreadTitle,
  );
  return `${PARENT_SECTION_COPY[section.relationship].ariaPrefix} ${parentThreadTitle}`;
}

const PARENT_THREAD_TITLE_CLASS =
  "text-foreground/90 underline underline-offset-2";

function ParentThreadInlineSegment({
  section,
}: {
  section: ThreadPromptParentThreadSection;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
      )}
      title={ariaLabel}
    >
      <Icon
        name={PARENT_SECTION_ICON[section.relationship]}
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {PARENT_SECTION_COPY[section.relationship].verb}{" "}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
      </span>
    </div>
  );
}

function ParentThreadSectionToggle({
  section,
  buttonRef,
  isExpanded,
  onToggle,
}: {
  section: ThreadPromptParentThreadSection;
  buttonRef: RefObject<HTMLButtonElement | null>;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);
  return (
    <SectionToggleButton
      buttonRef={buttonRef}
      fillRow={false}
      id={SECTION_IDS.parentThread.toggle}
      controlsId={SECTION_IDS.parentThread.body}
      ariaLabel={ariaLabel}
      icon={
        <Icon
          name={PARENT_SECTION_ICON[section.relationship]}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
      }
      label={null}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

function ParentThreadSectionBody({
  section,
  isExpanded,
  collapseRef,
  onCollapse,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
  collapseRef: RefObject<HTMLButtonElement | null>;
  onCollapse: () => void;
}) {
  return (
    <AnimatedDisclosureBody
      collapsedBorder="reserve"
      id={SECTION_IDS.parentThread.body}
      labelledBy={SECTION_IDS.parentThread.toggle}
      isExpanded={isExpanded}
      collapseLabel="Collapse parent thread"
      collapseRef={collapseRef}
      onCollapse={onCollapse}
    >
      <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
        {PARENT_SECTION_COPY[section.relationship].bodyLead}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
        .
      </div>
    </AnimatedDisclosureBody>
  );
}

const CHILD_THREAD_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-foreground/90 underline-offset-2 hover:underline";

// The strip is a state summary. Questions have one answer path in the
// relayed cards below it, using the same interaction as the child's own card.
function ActiveChildThreadsCard({
  childThreadsSection,
  isExpanded,
  onToggle,
}: {
  childThreadsSection: ThreadPromptChildThreadsSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);
  const items = childThreadsSection.items;
  const waiting = items.filter((item) => item.hasPendingInteraction).length;
  const working = items.filter((item) => !item.hasPendingInteraction);
  const summary = `${waiting} needs you · ${working.length} working`;
  if (items.length === 0) return null;
  return (
    <PromptStackCard ariaLabel="Child threads" className="overflow-hidden">
      <button
        ref={focus.triggerRef}
        type="button"
        id={SECTION_IDS.childThreads.toggle}
        aria-expanded={isExpanded}
        aria-controls={SECTION_IDS.childThreads.body}
        aria-label={`${items.length} active ${childThreadNoun(items.length)}`}
        onClick={focus.onTriggerClick}
        className={activityRowClass(
          "active",
          cn(
            PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          ),
        )}
      >
        <Icon
          name={waiting > 0 ? "CircleQuestion" : "ChildThread"}
          className={activityIconClass("active", "size-3.5 shrink-0")}
          aria-hidden="true"
        />
        <span
          className={activityTextClass(
            "active",
            "min-w-0 flex-1 truncate text-left font-normal",
          )}
        >
          {waiting > 0 ? summary : "Active child threads"}
        </span>
        <PromptStackCountSlot count={items.length} />
      </button>
      <AnimatedBody
        collapsedBorder="reserve"
        id={SECTION_IDS.childThreads.body}
        labelledBy={SECTION_IDS.childThreads.toggle}
        isExpanded={isExpanded}
      >
        <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pt-1.5">
          {working.map((item) => (
            <li key={item.id} className="text-xs">
              <NavLink to={item.href} className={CHILD_THREAD_ROW_CLASS}>
                <Icon
                  name="Loading"
                  className={cn(
                    "size-3.5 shrink-0 animate-spin motion-reduce:animate-none",
                    SIDEBAR_WORKING_STATUS_COLOR_CLASS,
                  )}
                  aria-label="Working"
                />
                <ThreadTitle title={item.title} tooltip className="flex-1" />
              </NavLink>
            </li>
          ))}
        </ul>
        <PromptStackCollapseRow
          buttonRef={focus.collapseRef}
          className="rounded-none"
          controlsId={SECTION_IDS.childThreads.body}
          label={`Collapse ${items.length} ${childThreadNoun(items.length)}`}
          onCollapse={focus.onCollapseClick}
        />
      </AnimatedBody>
    </PromptStackCard>
  );
}

export function ThreadChildQuestionCards({
  questions,
  ownInteractions = [],
}: {
  questions: readonly ChildThreadQuestion[];
  ownInteractions?: readonly PendingInteraction[];
}) {
  const layout = useAtomValue(multiPaneSplitLayoutAtom);
  const maximizedPaneId = useAtomValue(maximizedPaneIdAtom);
  const splitActive = useSplitWorkspaceActive();
  const panes = layout && splitActive ? listPanes(layout.root) : [];
  const maximizedPane = panes.find((pane) => pane.paneId === maximizedPaneId);
  const visibleChildThreads = new Set(
    (maximizedPane ? [maximizedPane] : panes).flatMap((pane) =>
      pane.content.kind === "thread" ? [pane.content.threadId] : [],
    ),
  );
  const seen = new Set(ownInteractions.map((interaction) => interaction.id));
  return questions
    .filter(({ interaction, childThreadId }) => {
      if (visibleChildThreads.has(childThreadId)) return false;
      if (
        seen.has(interaction.id) ||
        !["pending", "resolving"].includes(interaction.status)
      )
        return false;
      seen.add(interaction.id);
      return true;
    })
    .map(({ interaction, childThreadId, childTitle, href }) => (
      <div key={interaction.id} data-child-question-card={interaction.id}>
        <NavLink
          to={href}
          className="px-3 text-xs text-muted-foreground underline underline-offset-2"
        >
          <ThreadTitle title={childTitle} inline />
        </NavLink>
        <ThreadPendingInteractionBanners
          interactions={[interaction]}
          threadId={childThreadId}
        />
      </div>
    ));
}

function PendingBannerActionButton({
  pending,
  label,
  pendingLabel,
  onClick,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  onClick: () => void;
}) {
  return (
    <PromptBannerActionButton onClick={onClick} disabled={pending}>
      {pending ? pendingLabel : label}
    </PromptBannerActionButton>
  );
}

const NO_CHILD_THREAD_ITEMS: readonly ThreadPromptChildThreadItem[] = [];

function useExpandForNewNeedsInput(
  items: readonly ThreadPromptChildThreadItem[],
  isExpanded: boolean,
  onExpand: () => void,
) {
  const needsInputKey = items
    .filter((item) => item.hasPendingInteraction)
    .map((item) => item.id)
    .join(" ");
  const seenNeedsInputKey = useRef("");
  useEffect(() => {
    const seen = new Set(seenNeedsInputKey.current.split(" "));
    seenNeedsInputKey.current = needsInputKey;
    const hasNewNeedsInput =
      needsInputKey !== "" &&
      needsInputKey.split(" ").some((id) => !seen.has(id));
    if (hasNewNeedsInput && !isExpanded) {
      onExpand();
    }
  }, [needsInputKey, isExpanded, onExpand]);
}

type DisclosureFocusHandoff = ReturnType<typeof useDisclosureFocusHandoff>;

interface CoreThreadContextValue extends CoreThreadContext {
  parentFocus: DisclosureFocusHandoff;
}

const CoreThreadContextContext = createContext<CoreThreadContextValue | null>(
  null,
);

function useCoreThreadContext(): CoreThreadContextValue {
  const value = useContext(CoreThreadContextContext);
  if (value === null) {
    throw new Error("Core thread context segments render inside the banner");
  }
  return value;
}

function ParentThreadSummary({
  segments,
  isExpanded,
}: ExperimentalThreadContextSegmentProps) {
  const { parentThread, parentFocus } = useCoreThreadContext();
  if (parentThread === null) return null;
  return segments.length === 1 ? (
    <ParentThreadInlineSegment section={parentThread} />
  ) : (
    <ParentThreadSectionToggle
      section={parentThread}
      buttonRef={parentFocus.triggerRef}
      isExpanded={isExpanded}
      onToggle={parentFocus.onTriggerClick}
    />
  );
}

function ParentThreadDetails({
  segments,
  isExpanded,
}: ExperimentalThreadContextSegmentProps) {
  const { parentThread, parentFocus } = useCoreThreadContext();
  if (parentThread === null || segments.length === 1) return null;
  return (
    <ParentThreadSectionBody
      section={parentThread}
      isExpanded={isExpanded}
      collapseRef={parentFocus.collapseRef}
      onCollapse={parentFocus.onCollapseClick}
    />
  );
}

export function ThreadChildThreadsBanner({
  childThreads,
  isExpanded,
  onExpandedChange,
}: {
  childThreads: ThreadPromptChildThreadsSection | null;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
}) {
  const items = childThreads?.items ?? NO_CHILD_THREAD_ITEMS;
  useExpandForNewNeedsInput(items, isExpanded, () => onExpandedChange(true));
  if (childThreads === null || items.length === 0) return null;
  return (
    <ActiveChildThreadsCard
      childThreadsSection={childThreads}
      isExpanded={isExpanded}
      onToggle={() => onExpandedChange(!isExpanded)}
    />
  );
}

const SEGMENT_GROUPS = experimental_THREAD_CONTEXT_SEGMENT_GROUPS;

const coreThreadContextSegments: readonly CoreThreadContextSegment[] =
  collectPluginAppRegistrations(
    definePluginApp((app) => {
      app.slots.experimental_threadContextSegment({
        id: "parent-thread",
        title: "Parent thread",
        group: SEGMENT_GROUPS.thread,
        order: 10,
        summary: ParentThreadSummary,
        details: ParentThreadDetails,
        useVisible: () => {
          const { parentThread } = useCoreThreadContext();
          const kind = useThreadContextKind();
          return parentThread !== null && kind === "banner";
        },
      });
    }),
  ).threadContextSegments.map((slot) => ({
    ...slot,
    pluginId: CORE_THREAD_CONTEXT_OWNER,
  }));

function coreSlot(id: string): CoreThreadContextSegment {
  const slot = coreThreadContextSegments.find(
    (candidate) => candidate.id === id,
  );
  if (slot === undefined) throw new Error(`Missing core segment ${id}`);
  return slot;
}

const PARENT_THREAD_SLOT = coreSlot("parent-thread");
const PARENT_THREAD_ENTRY: ThreadContextSegmentEntry = {
  owner: "core",
  slot: PARENT_THREAD_SLOT,
};
const PARENT_THREAD_KEY = threadContextSegmentKey(PARENT_THREAD_SLOT);
const STATUS_KEY = `${CORE_THREAD_CONTEXT_OWNER}/status`;
const READ_ONLY_SEGMENTS = [
  { key: PARENT_THREAD_KEY, pluginId: CORE_THREAD_CONTEXT_OWNER },
  { key: STATUS_KEY, pluginId: CORE_THREAD_CONTEXT_OWNER },
];

interface ReadOnlyContextBannerProps {
  input: ExperimentalThreadContextSegmentInput;
  iconName: IconName;
  statusLabel: string;
  description: string | null;
  hasParentThread: boolean;
  statusAction: ReactNode;
  expandedSegment: string | null;
  onToggleSegment: (key: string) => void;
}

function ReadOnlyContextBanner({
  input,
  iconName,
  statusLabel,
  description,
  hasParentThread,
  statusAction,
  expandedSegment,
  onToggleSegment,
}: ReadOnlyContextBannerProps) {
  const isStatusExpanded =
    expandedSegment === STATUS_KEY && description !== null;
  const statusFocus = useDisclosureFocusHandoff(isStatusExpanded, () =>
    onToggleSegment(STATUS_KEY),
  );
  const statusIcon = (
    <Icon name={iconName} className="size-3.5 shrink-0" aria-hidden="true" />
  );
  const showStatusAction = statusAction !== null && !hasParentThread;
  const parentSegment = (part: ThreadContextSegmentPart) =>
    hasParentThread ? (
      <ThreadContextSegmentMount
        entry={PARENT_THREAD_ENTRY}
        {...input}
        part={part}
        segments={READ_ONLY_SEGMENTS}
        isExpanded={expandedSegment === PARENT_THREAD_KEY}
        onToggle={() => onToggleSegment(PARENT_THREAD_KEY)}
      />
    ) : null;
  return (
    <PromptStackCard
      ariaLabel="Thread history"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 text-xs text-muted-foreground",
          PROMPT_STACK_INLAY_INSET_CLASS,
        )}
      >
        {parentSegment("summary")}
        {description === null ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs",
              PROMPT_STACK_INLAY_SEGMENT_CLASS,
            )}
            role="status"
            aria-label={statusLabel}
          >
            {statusIcon}
            <span className="min-w-0 truncate" aria-hidden="true">
              {statusLabel}
            </span>
          </div>
        ) : (
          <SectionToggleButton
            buttonRef={statusFocus.triggerRef}
            fillRow
            id={SECTION_IDS.status.toggle}
            controlsId={SECTION_IDS.status.body}
            icon={statusIcon}
            label={statusLabel}
            hideLabelInCompact={false}
            isExpanded={isStatusExpanded}
            onToggle={statusFocus.onTriggerClick}
          />
        )}
        {showStatusAction ? (
          <BannerActionSlot>{statusAction}</BannerActionSlot>
        ) : null}
      </div>
      {description === null ? null : (
        <AnimatedDisclosureBody
          collapsedBorder="reserve"
          id={SECTION_IDS.status.body}
          labelledBy={SECTION_IDS.status.toggle}
          isExpanded={isStatusExpanded}
          collapseLabel={`Collapse ${statusLabel.toLowerCase()}`}
          collapseRef={statusFocus.collapseRef}
          onCollapse={statusFocus.onCollapseClick}
        >
          <p className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </AnimatedDisclosureBody>
      )}
      {parentSegment("details")}
    </PromptStackCard>
  );
}

function WritableContextBanner({
  input,
  expandedSegment,
  onToggleSegment,
}: {
  input: ExperimentalThreadContextSegmentInput;
  expandedSegment: string | null;
  onToggleSegment: (key: string) => void;
}) {
  const { entries, observers } = useThreadContextSegments(
    input,
    coreThreadContextSegments,
  );
  const segments = entries.map(({ slot }) => ({
    key: threadContextSegmentKey(slot),
    pluginId: slot.pluginId,
  }));
  const mount = (
    entry: ThreadContextSegmentEntry,
    part: ThreadContextSegmentPart,
  ) => {
    const key = threadContextSegmentKey(entry.slot);
    return (
      <ThreadContextSegmentMount
        key={threadContextSegmentMountKey(entry, input.threadId, part)}
        entry={entry}
        part={part}
        {...input}
        segments={segments}
        isExpanded={expandedSegment === key}
        onToggle={() => onToggleSegment(key)}
      />
    );
  };
  return (
    <>
      {observers}
      {entries.length > 0 ? (
        <PromptStackCard
          ariaLabel="Thread context before sending"
          className="overflow-hidden"
          style={{ minHeight: PROMPT_CONTEXT_BANNER_COLLAPSED_HEIGHT }}
        >
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs text-muted-foreground",
              PROMPT_STACK_INLAY_INSET_CLASS,
            )}
          >
            {entries.map((entry) => mount(entry, "summary"))}
            {entries.map((entry) => mount(entry, "action"))}
          </div>
          {entries.map((entry) => mount(entry, "details"))}
        </PromptStackCard>
      ) : null}
    </>
  );
}

export function ThreadPromptContextBanner({
  input,
  core,
  archivedSection,
  environmentGoneSection,
  expandedSegment,
  onToggleSegment,
}: ThreadPromptContextBannerProps) {
  const isReadOnly =
    archivedSection !== null || environmentGoneSection !== null;
  const parentFocus = useDisclosureFocusHandoff(
    expandedSegment === PARENT_THREAD_KEY,
    () => onToggleSegment(PARENT_THREAD_KEY),
  );
  const context: CoreThreadContextValue = { ...core, parentFocus };
  if (isReadOnly) {
    const environmentGoneCopy = environmentGoneSection
      ? ENVIRONMENT_GONE_STATUS_COPY[environmentGoneSection.status]
      : null;
    return (
      <CoreThreadContextContext.Provider value={context}>
        <ReadOnlyContextBanner
          input={input}
          iconName={environmentGoneSection ? "CircleX" : "Archive"}
          statusLabel={
            environmentGoneCopy?.label ?? ARCHIVED_THREAD_STATUS_LABEL
          }
          description={environmentGoneCopy?.description ?? null}
          statusAction={
            archivedSection?.onUnarchive ? (
              <PendingBannerActionButton
                pending={Boolean(archivedSection.unarchivePending)}
                label="Unarchive"
                pendingLabel="Unarchiving..."
                onClick={archivedSection.onUnarchive}
              />
            ) : environmentGoneSection?.onRestore ? (
              <PendingBannerActionButton
                pending={Boolean(environmentGoneSection.restorePending)}
                label="Restore workspace"
                pendingLabel="Restoring..."
                onClick={environmentGoneSection.onRestore}
              />
            ) : null
          }
          hasParentThread={core.parentThread !== null}
          expandedSegment={expandedSegment}
          onToggleSegment={onToggleSegment}
        />
      </CoreThreadContextContext.Provider>
    );
  }
  return (
    <CoreThreadContextContext.Provider value={context}>
      <WritableContextBanner
        input={input}
        expandedSegment={expandedSegment}
        onToggleSegment={onToggleSegment}
      />
    </CoreThreadContextContext.Provider>
  );
}
