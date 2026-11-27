import { QuestionNavigator } from "@/components/thread/user-questions/QuestionNavigator";
import {
  ComposerContextProvider,
  ComposerContextSources,
  ComposerContextItem,
} from "./context/composer-context";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { ComposerPlanSteps } from "./context/ThreadComposerPlan";
import { ThreadTodoCard } from "./banner/ThreadTodoCard";
import { ThreadChildThreadsBanner } from "./banner/ThreadPromptContextBanner";
import type { PlanSnapshotView } from "@bb/domain";
import "../../../.ladle/composer-plugin";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  Environment,
  Host,
  PermissionMode,
  PromptMentionResource,
  PromptTextMention,
  ThreadQueuedMessage,
} from "@bb/domain";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import type {
  SystemExecutionOptionsModelLoadError,
  ThreadContextWindowUsage,
} from "@bb/server-contract";
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "@/components/promptbox/follow-up-placeholder";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
} from "@/lib/environment-workspace-display";
import type {
  AttachmentsConfig,
  PromptBoxAction,
} from "@/components/promptbox/ComposerBox";
import { ThreadPromptContextBanner } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import type {
  QueuedMessageEditRequest,
  QueuedMessageInlineEditor,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import { QueuedMessagesList } from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { CompactBeforeSendOffer } from "@/components/promptbox/CompactBeforeSendChip";
import {
  formatWorkspaceCheckoutDisplay,
  type WorkspaceCheckoutDisplay,
} from "@bb/shared-ui/lib/workspace-checkout-display";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import { selectWorkspaceChangedFilesSection } from "../../../../../plugins/git/ui/workspace-change-summary";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  GitSegmentFixtureProvider,
  gitSegmentFixtureMergeBase,
} from "@/test/fixtures/git-segment-plugin";
import { ModelPickerStoryQueryProvider } from "../../../.ladle/model-picker-query-provider";
import {
  makeEnvironment,
  makeExecutionControlsProps,
  makeTypeaheadConfig,
  useInteractiveExecutionControls,
  STORY_ENVIRONMENT_PROVIDERS,
  PROJECT_NAMES,
  STORY_PROVIDER_OPTIONS,
} from "../../../.ladle/story-fixtures";
import type {
  ExecutionControlsProps,
  ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import { PageShell } from "@/components/ui/page-shell.js";
import { promptDraftToInput, queuedInputToDraft } from "@bb/client-core";
import {
  createComposerDraftStore,
  type ComposerDraftStore,
} from "@/components/plugin/plugin-composer-host";
import { useComposerDraftFixture } from "@/test/fixtures/composer-draft";
import type { WorkspaceStatus } from "bb-plugin-bb--git/contract";

export default {
  title: "promptbox/Follow Up Prompt Box",
};

const noop = () => {};
const noopAsync = async () => {};
const STORY_BRANCH_NAME = "bb/design-system-polish";

const baseExecution = makeExecutionControlsProps({
  provider: {
    options: STORY_PROVIDER_OPTIONS,
    selectedId: "codex",
    hasMultiple: true,
  },
});
const codexModelLoadError = {
  providerId: "codex",
  code: "failed",
  detail: "model list command_failed: codex exited before responding",
} satisfies SystemExecutionOptionsModelLoadError;

const permissionModeOptions: readonly PickerOption<PermissionMode>[] = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
];

const basePermission: ExecutionPermissionConfig = {
  value: "auto",
  options: permissionModeOptions,
  onChange: noop,
  supported: true,
};

const promptActions: readonly PromptBoxAction[] = [
  { kind: "skills", text: "/" },
  {
    kind: "plan",
    command: { trigger: "/", name: "plan", trailingText: " " },
    text: "/plan ",
  },
  {
    kind: "goal",
    command: { trigger: "/", name: "goal", trailingText: " " },
    text: "/goal ",
  },
];

interface EnvironmentSummaryArgs {
  environment: Environment;
  host: EnvironmentDisplayHostContext;
  projectName?: string | null;
  machineName?: string;
  hasMultipleMachines?: boolean;
  hostType?: Host["type"];
  branchName?: string;
  environmentCheckout?: WorkspaceCheckoutDisplay;
}

function makeEnvironmentSummary({
  environment,
  host,
  projectName = PROJECT_NAMES.bb,
  machineName,
  hasMultipleMachines = false,
  hostType = "persistent",
  branchName,
  environmentCheckout,
}: EnvironmentSummaryArgs): ReactNode {
  const providerLookup = findEnvironmentDisplayProvider(
    STORY_ENVIRONMENT_PROVIDERS,
    environment.environmentProviderId,
  );
  const display = formatEnvironmentDisplay({
    environment,
    host,
    providerLookup,
  });
  const chrome = getEnvironmentSummaryChrome({
    display,
    providerLookup,
    hasMultipleMachines,
    host:
      machineName === undefined
        ? null
        : { name: machineName, type: hostType, machineProviderId: null },
    machineProviders: undefined,
  });
  const checkoutDisplay =
    environmentCheckout ??
    (branchName
      ? formatWorkspaceCheckoutDisplay({
          checkout: {
            kind: "branch",
            branchName,
            headSha: null,
          },
        })
      : undefined);
  return (
    <ThreadEnvironmentSummary
      projectName={projectName ?? undefined}
      environmentLabel={chrome.environmentLabel}
      environmentCompactLabel={chrome.environmentCompactLabel}
      environmentIcon={chrome.environmentIcon}
      environmentProviderName={chrome.environmentProviderName}
      environmentHost={chrome.environmentHost}
      environmentMachineProvider={chrome.environmentMachineProvider}
      environmentCheckout={checkoutDisplay}
      onCreateNewThreadInEnvironment={
        environment.status === "ready" && environment.path !== null
          ? noop
          : undefined
      }
    />
  );
}

const localEnvironmentDisplayHost: EnvironmentDisplayHostContext = {
  locality: "local",
  identity: null,
};

const remoteEnvironmentDisplayHost: EnvironmentDisplayHostContext = {
  locality: "remote",
  identity: null,
};

const localEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    status: "ready",
  }),
  host: localEnvironmentDisplayHost,
  branchName: STORY_BRANCH_NAME,
});

const multiMachineEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    status: "ready",
  }),
  host: localEnvironmentDisplayHost,
  machineName: "Build Mac mini",
  hasMultipleMachines: true,
  branchName: STORY_BRANCH_NAME,
});

const sandboxWorktreeEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    environmentProviderId: "git-worktree",
    status: "ready",
  }),
  host: remoteEnvironmentDisplayHost,
  machineName: "Modal sandbox",
  hostType: "ephemeral",
  branchName: STORY_BRANCH_NAME,
});

const namedLocalEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    name: "Linked review tree",
    status: "ready",
  }),
  host: localEnvironmentDisplayHost,
  machineName: "Bersabel's MacBook Pro",
  hasMultipleMachines: true,
  branchName: STORY_BRANCH_NAME,
});

const detachedWorktreeEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    environmentProviderId: "git-worktree",
    status: "ready",
  }),
  host: localEnvironmentDisplayHost,
  machineName: "Bersabel's MacBook Pro",
  environmentCheckout: formatWorkspaceCheckoutDisplay({
    checkout: {
      kind: "detached",
      headSha: "abcdef1234567890",
    },
  }),
});

const provisioningEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    path: null,
    status: "provisioning",
  }),
  host: localEnvironmentDisplayHost,
});

const personalEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    environmentProviderId: "personal-workspace",
    branchName: null,
    status: "ready",
  }),
  host: localEnvironmentDisplayHost,
  projectName: null,
});

const destroyedEnvironmentSummary: ReactNode = makeEnvironmentSummary({
  environment: makeEnvironment({
    path: null,
    status: "destroyed",
  }),
  host: localEnvironmentDisplayHost,
});

const usage: ThreadContextWindowUsage = {
  usedTokens: 32_400,
  modelContextWindow: 128_000,
  estimated: false,
};

const typeaheadBase = makeTypeaheadConfig();

const attachmentsBase: AttachmentsConfig = {
  projectId: "proj_demo",
  isAttaching: false,
  error: null,
  onAttachFiles: async () => [],
  onUpdate: noop,
};

const historyEntries = [
  { text: "review thread workspace", mentions: [], attachments: [] },
  {
    text: "investigate timeline pagination",
    mentions: [],
    attachments: [],
  },
];

interface StoryMentionSpec {
  token: string;
  resource: PromptMentionResource;
}

function storyMention(
  text: string,
  { token, resource }: StoryMentionSpec,
): PromptTextMention {
  const start = text.indexOf(token);
  if (start < 0) {
    throw new Error(`Missing story mention token: ${token}`);
  }
  return {
    start,
    end: start + token.length,
    resource,
  };
}

function buildStoryMentions(
  text: string,
  mentionSpecs: readonly StoryMentionSpec[],
): PromptTextMention[] {
  return mentionSpecs.map((spec) => storyMention(text, spec));
}

const stackedCardsWithPillsMessage = [
  "> Review @apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
  "> with @thread:thr_prompt_pills, then run /github:gh-fix-ci.",
  "",
  "This paragraph should stay outside the collapsed one-line preview.",
].join("\n");

const stackedCardsWithPillsMentions = buildStoryMentions(
  stackedCardsWithPillsMessage,
  [
    {
      token: "@apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
      resource: {
        kind: "path",
        source: "workspace",
        entryKind: "file",
        path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
        label: "FollowUpPromptBox.tsx",
      },
    },
    {
      token: "@thread:thr_prompt_pills",
      resource: {
        kind: "thread",
        projectId: "proj_promptbox",
        threadId: "thr_prompt_pills",
        label: "Prompt pills QA",
      },
    },
    {
      token: "/github:gh-fix-ci",
      resource: {
        kind: "command",
        trigger: "/",
        name: "github:gh-fix-ci",
        source: "skill",
        origin: "user",
        label: "github:gh-fix-ci",
        argumentHint: null,
      },
    },
  ],
);

const dirtyWorkspaceStatus: WorkspaceStatus = {
  workingTree: {
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: [
      {
        path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
        status: "M",
        insertions: 42,
        deletions: 18,
      },
      {
        path: "apps/app/src/views/ThreadDetailPromptArea.tsx",
        status: "M",
        insertions: 12,
        deletions: 6,
      },
      {
        path: "apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx",
        status: "A",
        insertions: 74,
        deletions: 0,
      },
    ],
    insertions: 128,
    deletions: 24,
    lineStatsComplete: true,
    fileCount: 3,
  },
  branch: {
    currentBranch: STORY_BRANCH_NAME,
    defaultBranch: "main",
  },
  checkout: {
    kind: "branch",
    branchName: STORY_BRANCH_NAME,
    headSha: null,
  },
  mergeBase: null,
  allChanges: {
    insertions: 128,
    deletions: 24,
    lineStatsComplete: true,
    fileCount: 3,
  },
};

const dirtyContextBannerSection =
  selectWorkspaceChangedFilesSection(dirtyWorkspaceStatus);

const contextBannerElement: ReactNode = dirtyContextBannerSection ? (
  <GitSegmentFixtureProvider
    value={{
      section: dirtyContextBannerSection,
      mergeBase: gitSegmentFixtureMergeBase(),
    }}
  >
    <ThreadPromptContextBanner
      input={{
        threadId: "thr_story",
        projectId: "proj_story",
        environment: null,
      }}
      core={{
        parentThread: null,
      }}
      archivedSection={null}
      environmentGoneSection={null}
      expandedSegment={null}
      onToggleSegment={noop}
    />
  </GitSegmentFixtureProvider>
) : null;

const archivedContextBannerElement: ReactNode = (
  <ThreadPromptContextBanner
    input={{
      threadId: "thr_story",
      projectId: "proj_story",
      environment: null,
    }}
    core={{
      parentThread: null,
    }}
    archivedSection={{ archivedAt: 1_731_456_000_000 }}
    environmentGoneSection={null}
    expandedSegment={null}
    onToggleSegment={noop}
  />
);

const environmentGoneContextBannerElement: ReactNode = (
  <ThreadPromptContextBanner
    input={{
      threadId: "thr_story",
      projectId: "proj_story",
      environment: null,
    }}
    core={{
      parentThread: null,
    }}
    archivedSection={null}
    environmentGoneSection={{ status: "destroyed" }}
    expandedSegment={null}
    onToggleSegment={noop}
  />
);

function makeStoryQueuedMessage(id: string, text: string): ThreadQueuedMessage {
  return makeThreadQueuedMessage({
    id,
    threadId: "thr_prompt_pills",
    content: [{ type: "text", text, mentions: [] }],
  });
}

const queuedMessages: readonly ThreadQueuedMessage[] = [
  makeStoryQueuedMessage("q_1", "Also check the timeline error overlay."),
  makeStoryQueuedMessage(
    "q_2",
    "Confirm the environment summary renders without the branch button on unmanaged environments.",
  ),
  makeStoryQueuedMessage(
    "q_3",
    "Edit this queued prompt in the expanded workspace and keep the same real composer.",
  ),
  makeStoryQueuedMessage("q_4", "Compare the queue in light and dark themes."),
  makeStoryQueuedMessage("q_5", "Verify keyboard reordering from each grip."),
  makeStoryQueuedMessage("q_6", "Run the prompt-box typecheck."),
  makeStoryQueuedMessage("q_7", "Review the queue at a narrow width."),
  makeStoryQueuedMessage("q_8", "Capture the final interaction states."),
];

const STORY_NOW = Date.UTC(2026, 9, 8, 15, 0);

const queuedMessagesWithReasons: readonly ThreadQueuedMessage[] = [
  {
    ...makeStoryQueuedMessage("q_failed", "Summarize the diff for the team."),
    failureReason: "Workspace cleanup is pending. Try again shortly.",
    createdAt: STORY_NOW - 30 * 60_000,
  },
  {
    ...makeStoryQueuedMessage(
      "q_plain",
      "Also run the tests when you're done.",
    ),
    createdAt: STORY_NOW - 20 * 60_000,
  },
  {
    ...makeStoryQueuedMessage("q_scheduled", "Post the summary to the team."),
    waitingOn: { kind: "time" },
    sendAt: STORY_NOW + 2 * 60 * 60_000,
    createdAt: STORY_NOW - 10 * 60_000,
  },
  {
    ...makeStoryQueuedMessage("q_draft", "Draft: release notes outline."),
    waitingOn: { kind: "plugin", pluginId: "drafts", reason: "Draft" },
    createdAt: STORY_NOW - 5 * 60_000,
  },
];

type RowPermission = Parameters<typeof FollowUpPromptBox>[0]["permission"];

interface RowConfig {
  contextHost?: boolean;
  initialMessage?: string;
  initialMentions?: PromptTextMention[];
  submitMode: FollowUpSubmitMode;
  isFollowUpSubmitting?: boolean;
  threadRuntimeDisplayStatus?: FollowUpComposerRuntimeStatus;
  promptPlaceholder?: string;
  environmentSummary?: ReactNode | null;
  contextWindowUsage?: ThreadContextWindowUsage | null;
  compactBeforeSend?: CompactBeforeSendOffer | null;
  stack?: ReactNode | null;
  queuedMessages?: readonly ThreadQueuedMessage[];
  collapseResetKey?: string;
  hideComposer?: boolean;
  execution?: ExecutionControlsProps;
  permission?: RowPermission;
  activePromptMode?: Parameters<
    typeof FollowUpPromptBox
  >[0]["activePromptMode"];
  readOnly?: boolean;
}

type FollowUpComposerRuntimeStatus = NonNullable<
  Parameters<typeof FollowUpPromptBox>[0]["composer"]
>["threadRuntimeDisplayStatus"];

function PromptStage({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-w-0 bg-background">
      <PageShell
        shellClassName="!mx-0 !mt-0 !h-auto !min-h-0 !flex-none md:!mx-0 md:!mt-0"
        scrollAreaClassName="hidden"
        footerClassName="chat-prompt-box"
        footer={children}
      >
        <span aria-hidden="true" />
      </PageShell>
    </div>
  );
}

function Row({
  initialMessage = "",
  initialMentions = [],
  submitMode,
  isFollowUpSubmitting = false,
  threadRuntimeDisplayStatus = "idle",
  promptPlaceholder,
  environmentSummary = localEnvironmentSummary,
  contextWindowUsage = null,
  compactBeforeSend = null,
  stack = null,
  queuedMessages: initialQueuedMessages,
  collapseResetKey = "thr_demo",
  hideComposer = false,
  execution = baseExecution,
  permission = basePermission,
  activePromptMode = null,
  readOnly = false,
  contextHost = false,
}: RowConfig) {
  const draft = useComposerDraftFixture(initialMessage, initialMentions);
  const [queueExpanded, setQueueExpanded] = useState(true);
  const [storyQueuedMessages, setStoryQueuedMessages] = useState(
    initialQueuedMessages ?? [],
  );
  const [inlineEditingQueuedMessage, setInlineEditingQueuedMessage] = useState<{
    draft: ComposerDraftStore;
    queuedMessageId: string;
    queuedMessageIndex: number;
  } | null>(null);
  const resolvedPlaceholder =
    promptPlaceholder ??
    getFollowUpPromptPlaceholder(threadRuntimeDisplayStatus);
  const resolvedCompactPlaceholder =
    promptPlaceholder ??
    getCompactFollowUpPromptPlaceholder(threadRuntimeDisplayStatus);
  const dismissInlineEditor = useCallback(() => {
    setInlineEditingQueuedMessage(null);
  }, []);
  const handleEditQueuedMessage = useCallback(
    ({ queuedMessageId, queuedMessageIndex }: QueuedMessageEditRequest) => {
      const queuedMessage = storyQueuedMessages.find(
        (candidate) => candidate.id === queuedMessageId,
      );
      if (!queuedMessage) return;
      setInlineEditingQueuedMessage({
        draft: createComposerDraftStore(
          queuedInputToDraft(queuedMessage.content),
        ),
        queuedMessageId,
        queuedMessageIndex,
      });
    },
    [storyQueuedMessages],
  );
  const handleSubmit = useCallback(() => {
    if (!inlineEditingQueuedMessage) return;
    const input = promptDraftToInput(
      inlineEditingQueuedMessage.draft.getCurrent(),
    );
    if (input.length === 0) return;
    setStoryQueuedMessages((current) =>
      current.map((queuedMessage) =>
        queuedMessage.id === inlineEditingQueuedMessage.queuedMessageId
          ? { ...queuedMessage, content: input, updatedAt: Date.now() }
          : queuedMessage,
      ),
    );
    dismissInlineEditor();
  }, [dismissInlineEditor, inlineEditingQueuedMessage]);
  const inlineEditor = useMemo<QueuedMessageInlineEditor | undefined>(
    () =>
      inlineEditingQueuedMessage
        ? {
            queuedMessageId: inlineEditingQueuedMessage.queuedMessageId,
            queuedMessageIndex: inlineEditingQueuedMessage.queuedMessageIndex,
            content: (
              <FollowUpPromptBox
                attachments={attachmentsBase}
                stack={null}
                composer={{
                  history: {
                    entries: [],
                    onSelectEntry: noop,
                  },
                  isFollowUpSubmitting: false,
                  draft: inlineEditingQueuedMessage.draft,
                  onModifierSubmit: handleSubmit,
                  onSubmit: handleSubmit,
                  compactPromptPlaceholder: resolvedCompactPlaceholder,
                  promptPlaceholder: resolvedPlaceholder,
                  canModifierSubmit: true,
                  steerActiveThreadOnEnter: false,
                  submitMode: { kind: "ready" },
                  threadRuntimeDisplayStatus,
                }}
                environmentSummary={null}
                contextWindowUsage={null}
                execution={execution}
                executionReadOnly
                permission={permission}
                permissionReadOnly
                promptActions={promptActions}
                typeahead={typeaheadBase}
                collapseResetKey={`${collapseResetKey}:queued-message`}
                isPrimaryComposer={false}
                showScrollToBottomButton={false}
              />
            ),
            onDismiss: dismissInlineEditor,
          }
        : undefined,
    [
      dismissInlineEditor,
      execution,
      handleSubmit,
      inlineEditingQueuedMessage,
      permission,
      resolvedCompactPlaceholder,
      resolvedPlaceholder,
      threadRuntimeDisplayStatus,
      collapseResetKey,
    ],
  );
  const queueElement =
    initialQueuedMessages === undefined ? null : (
      <QueuedMessagesList
        attachedToComposer={true}
        queuedMessages={storyQueuedMessages}
        inlineEditor={inlineEditor}
        sendAction="send-now"
        threadStatus="active"
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={(id) =>
          setStoryQueuedMessages((current) =>
            current.filter((message) => message.id !== id),
          )
        }
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={handleEditQueuedMessage}
        onChangeSendTime={noopAsync}
        expanded={queueExpanded}
        onExpandedChange={setQueueExpanded}
        onDelete={(id) =>
          setStoryQueuedMessages((current) =>
            current.filter((message) => message.id !== id),
          )
        }
      />
    );
  const resolvedStack = queueElement ? (
    <>
      {stack}
      {queueElement}
    </>
  ) : (
    stack
  );
  return (
    <PromptStage>
      <FollowUpPromptBox
        contextHost={contextHost}
        attachments={attachmentsBase}
        stack={resolvedStack}
        composer={
          hideComposer
            ? null
            : {
                history: {
                  entries: historyEntries,
                  onSelectEntry: noop,
                },
                isFollowUpSubmitting,
                draft,
                onModifierSubmit: noop,
                onSubmit: noop,
                compactPromptPlaceholder: resolvedCompactPlaceholder,
                promptPlaceholder: resolvedPlaceholder,
                canModifierSubmit: submitMode.kind === "queue",
                steerActiveThreadOnEnter: false,
                submitMode,
                threadRuntimeDisplayStatus,
              }
        }
        environmentSummary={environmentSummary}
        contextWindowUsage={contextWindowUsage}
        compactBeforeSend={compactBeforeSend}
        execution={execution}
        permission={permission}
        activePromptMode={activePromptMode}
        promptActions={promptActions}
        executionReadOnly={readOnly}
        permissionReadOnly={readOnly}
        typeahead={typeaheadBase}
        collapseResetKey={collapseResetKey}
      />
    </PromptStage>
  );
}

function StackedCardsWithPillsRow() {
  return (
    <Row
      submitMode={{ kind: "queue", onStop: noop }}
      threadRuntimeDisplayStatus="active"
      initialMessage={stackedCardsWithPillsMessage}
      initialMentions={stackedCardsWithPillsMentions}
      stack={contextBannerElement}
      queuedMessages={queuedMessages}
      contextWindowUsage={usage}
      environmentSummary={multiMachineEnvironmentSummary}
    />
  );
}

const expiredCacheUsage: ThreadContextWindowUsage = {
  usedTokens: 331_000,
  modelContextWindow: 1_000_000,
  estimated: false,
};

function CompactBeforeSendRow() {
  const [compactFirst, setCompactFirst] = useState(true);
  return (
    <Row
      submitMode={{ kind: "ready" }}
      contextWindowUsage={expiredCacheUsage}
      compactBeforeSend={{
        compactFirst,
        tokens: expiredCacheUsage.usedTokens,
        onCompactFirstChange: setCompactFirst,
      }}
    />
  );
}

function InteractiveRow() {
  const execution = useInteractiveExecutionControls(baseExecution);
  return (
    <ModelPickerStoryQueryProvider>
      <Row submitMode={{ kind: "ready" }} execution={execution} />
    </ModelPickerStoryQueryProvider>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="ready"
        hint="interactive provider, model, reasoning, and fast mode"
      >
        <InteractiveRow />
      </StoryRow>
      <StoryRow
        label="loading models"
        hint="locked provider while execution options load"
      >
        <Row
          submitMode={{ kind: "ready" }}
          execution={{
            ...baseExecution,
            model: {
              ...baseExecution.model,
              active: null,
              selected: "",
              options: [],
              isLoading: true,
              loadFailed: false,
            },
          }}
          environmentSummary={namedLocalEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow
        label="model load failed"
        hint="locked provider with structured modelLoadError"
      >
        <Row
          submitMode={{ kind: "ready" }}
          execution={{
            ...baseExecution,
            model: {
              ...baseExecution.model,
              active: null,
              selected: "",
              options: [],
              isLoading: false,
              loadFailed: true,
              loadError: codexModelLoadError,
            },
          }}
          environmentSummary={multiMachineEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow label="no models" hint="locked provider with empty catalog">
        <Row
          submitMode={{ kind: "ready" }}
          execution={{
            ...baseExecution,
            model: {
              ...baseExecution.model,
              active: null,
              selected: "",
              options: [],
              isLoading: false,
              loadFailed: false,
              loadError: null,
            },
          }}
          environmentSummary={detachedWorktreeEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow
        label="prompt cache expired"
        hint="click the chip to switch between compacting first and keeping the full history"
      >
        <CompactBeforeSendRow />
      </StoryRow>
      <StoryRow label="with promptbox context banner">
        <Row
          submitMode={{ kind: "ready" }}
          stack={contextBannerElement}
          environmentSummary={localEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow
        label="archived: composer hidden"
        hint="read-only banner remains; prompt input and footer controls are collapsed"
      >
        <Row
          submitMode={{ kind: "blocked", reason: "pending-interaction" }}
          stack={archivedContextBannerElement}
          hideComposer
        />
      </StoryRow>
      <StoryRow
        label="environment gone: composer hidden"
        hint="destroyed environment uses the prompt context banner path"
      >
        <Row
          submitMode={{ kind: "blocked", reason: "pending-interaction" }}
          stack={environmentGoneContextBannerElement}
          hideComposer
        />
      </StoryRow>
      <StoryRow
        label="fitted queue above the composer"
        hint="toggle the full Queue header in either direction, or collapse below the messages; hover the bottom row to inspect the composer corners"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          queuedMessages={queuedMessages.slice(0, 2)}
        />
      </StoryRow>
      <StoryRow
        label="queue with reasons"
        hint="collapse the queue: the header names the failed send, which outranks the newer draft; delete it to see the newest reason (the draft). Open it to check the caret row and the gap above it; the count pill sits on the composer caret's axis"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          queuedMessages={queuedMessagesWithReasons}
        />
      </StoryRow>
      <StoryRow
        label="stacked cards with Markdown + pills"
        hint="scroll the overflowing queue and toggle its header; edit a message to open the inline composer, or collapse the main composer on mobile"
      >
        <StackedCardsWithPillsRow />
      </StoryRow>
      <StoryRow
        label="provisioning"
        hint="runtime loading icon + lifecycle label"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="starting"
          environmentSummary={provisioningEnvironmentSummary}
        />
      </StoryRow>
    </StoryCard>
  );
}

export function EnvironmentSummary() {
  return (
    <StoryCard>
      <StoryRow
        label="ready · one machine"
        hint="provider name; the machine is unambiguous so it stays hidden"
      >
        {localEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="ready · personal workspace"
        hint="no project chip, no branch; the provider names the environment"
      >
        {personalEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="ready · second machine"
        hint="machine name once more than one machine exists"
      >
        {multiMachineEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="ready · worktree on a sandbox"
        hint="an ephemeral host is ambiguous, so it is named"
      >
        {sandboxWorktreeEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="ready · named environment"
        hint="a custom name wins over both machine and provider"
      >
        {namedLocalEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="ready · detached worktree"
        hint="provider icon · detached commit checkout"
      >
        {detachedWorktreeEnvironmentSummary}
      </StoryRow>
      <StoryRow
        label="destroyed environment"
        hint="lifecycle label replaces the provider name"
      >
        {destroyedEnvironmentSummary}
      </StoryRow>
    </StoryCard>
  );
}

const contextPlanFixture: PlanSnapshotView = {
  sourceSeq: 1,
  updatedAt: STORY_NOW,
  items: [
    {
      id: "inspect",
      text: "Проверить исходные панели и их владельцев",
      status: "completed",
      interactionIds: [],
    },
    {
      id: "design",
      text: "Согласовать компактную структуру",
      status: "completed",
      interactionIds: [],
    },
    {
      id: "build",
      text: "Общий composer и раскрытие контекста",
      status: "in_progress",
      interactionIds: [],
    },
    {
      id: "test",
      text: "Проверить узкую панель и длинные заголовки",
      status: "pending",
      interactionIds: [],
    },
    {
      id: "screens",
      text: "Снять before / after",
      status: "pending",
      interactionIds: [],
    },
    {
      id: "review",
      text: "Передать коммит на независимое ревью",
      status: "pending",
      interactionIds: [],
    },
  ],
};
function ContextFixtureScene({ after }: { after: boolean }) {
  const [childrenExpanded, setChildrenExpanded] = useState(false);
  const content = (
    <div
      className="@container/thread-chat mx-auto w-full max-w-3xl bg-background p-4"
      style={{ height: 650 }}
    >
      <header className="flex h-8 items-center gap-3 border-b border-border pb-3 text-sm font-medium">
        UI-правки: кнопки шапки, счётчики тредов, средний клик, ресайзеры
      </header>
      <div className="h-72 overflow-hidden py-5 text-sm">
        <p className="ml-12 rounded-xl bg-muted p-3">
          Постоянно дёргается высота панели чата из-за появления текста. Лучше
          куда-то вправо его переместить, чтобы композиция элементов не
          менялась.
        </p>
        <p className="py-5">
          Проверяю общий overlay и геометрию ползунков на плотной сцене.
        </p>
        <p className="text-xs text-muted-foreground">
          Edited card-stability.test.tsx +20
        </p>
      </div>
      {after ? (
        <ComposerContextSources>
          <ComposerContextItem
            id="plan"
            label="Plan"
            summary="2/6"
            group="work"
            icon="ListTodo"
          >
            <ComposerPlanSteps
              snapshot={contextPlanFixture}
              executing
              onQuestion={noop}
            />
          </ComposerContextItem>
          <ComposerContextItem
            id="questions"
            label="Questions unavailable"
            group="attention"
            tone="error"
            icon="AlertCircle"
          >
            <p className="text-xs text-destructive-text">
              Questions unavailable
            </p>
            <p className="my-2 text-xs text-muted-foreground">
              Failed to fetch open questions. Existing questions may still need
              your answer.
            </p>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
            >
              Retry
            </button>
          </ComposerContextItem>
        </ComposerContextSources>
      ) : (
        <>
          <ThreadTodoCard
            threadId="thr_story"
            placement="overlay"
            snapshot={contextPlanFixture}
            earlier={false}
            narrow
            executing
            interactions={[]}
            compact
          />
          <p className="py-2 text-xs text-destructive-text">
            Questions unavailable · Retry
          </p>
        </>
      )}
      <Row
        contextHost={after}
        submitMode={{ kind: "ready" }}
        initialMessage=""
        stack={
          <>
            <ThreadChildThreadsBanner
              childThreads={{
                items: Array.from({ length: 12 }, (_, i) => ({
                  id: `child-${i}`,
                  title: [
                    "Статусы в UI пропадают: механизм обновления",
                    "Ядро: быстрое чтение в изолированной лаборатории",
                    "UI-правки: кнопки шапки, счётчики тредов, средний клик, ресайзеры",
                  ][i % 3]!,
                  href: `/threads/child-${i}`,
                  needsOwnerAttention: i === 3,
                })),
              }}
              isExpanded={childrenExpanded}
              onExpandedChange={setChildrenExpanded}
            />
            {contextBannerElement}
          </>
        }
        queuedMessages={queuedMessages}
      />
    </div>
  );
  return after ? (
    <ComposerContextProvider>{content}</ComposerContextProvider>
  ) : (
    content
  );
}
export function ComposerContextBefore() {
  return (
    <ModelPickerStoryQueryProvider>
      <ContextFixtureScene after={false} />
    </ModelPickerStoryQueryProvider>
  );
}
export function ComposerContextAfter() {
  return (
    <ModelPickerStoryQueryProvider>
      <ContextFixtureScene after />
    </ModelPickerStoryQueryProvider>
  );
}

interface StoryOpenQuestion {
  id: string;
  title: string;
  createdAt: number;
}
const storyOpenQuestions: { current: readonly StoryOpenQuestion[] } = {
  current: [],
};
function stageStoryOpenQuestions(questions: readonly StoryOpenQuestion[]) {
  storyOpenQuestions.current = questions;
  installStoryQuestionFetch();
}
let storyFetchInstalled = false;
function installStoryQuestionFetch() {
  if (storyFetchInstalled || typeof window === "undefined") return;
  storyFetchInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("/questions/open"))
      return original(input as RequestInfo, init);
    const questions = storyOpenQuestions.current.map((question) => ({
      id: question.id,
      threadId: "thr_story",
      status: "open",
      createdAt: question.createdAt,
      publication: { questions: [{ prompt: question.title }] },
    }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          questions,
          total: questions.length,
          nextCursor: null,
          readRevision: "r1",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
}

const SCENE_CHILD_TITLES = [
  "«Недавние» в сайдбаре: миниатюры обложек",
  "Реестр призов, городов и глоссарий",
  "CI на своём раннере",
  "Каталог: полки по времени",
  "Страница внешнего соревнования",
  "SEO и GEO OrangeHack: стратегия, домены, воронки",
  "Ускорение CI и деплоя на stage",
  "Трассировка этапов CI и деплоя",
  "Выпуск каталога и витрины на stage",
];

interface ContextSceneConfig {
  plan?: boolean;
  questions?: number;
  children?: { total: number; waiting: number; finished?: number };
  changes?: boolean;
  parent?: boolean;
  error?: boolean;
  width?: number;
  timeline?: boolean;
}

function ContextScene({
  plan = false,
  questions = 0,
  children,
  changes = false,
  parent = false,
  error = false,
  width,
  timeline = false,
}: ContextSceneConfig) {
  stageStoryOpenQuestions(
    Array.from({ length: questions }, (_, i) => ({
      id: `question-${i}`,
      title: [
        "Принять видимые изменения #949 по превью?",
        "Какой домен оставить для внешнего соревнования?",
        "Включить автослияние после зелёного CI?",
      ][i % 3]!,
      createdAt: STORY_NOW - (i + 1) * 3_600_000,
    })),
  );
  const bannerKey = `${changes}-${parent}`;
  const composer = (
    <>
      <ComposerContextSources>
        {plan ? (
          <ComposerContextItem
            id="plan"
            label="Plan"
            summary="3/6"
            progress={{ done: 3, total: 6 }}
            kind="plan"
            group="work"
            icon="ListTodo"
          >
            <ComposerPlanSteps
              snapshot={contextPlanFixture}
              executing
              onQuestion={noop}
            />
          </ComposerContextItem>
        ) : null}
        {questions > 0 ? <QuestionNavigator threadId="thr_story" /> : null}
        {error ? (
          <ComposerContextItem
            id="machine"
            label="pc2 offline"
            group="attention"
            tone="error"
            icon="AlertCircle"
          >
            <p className="text-xs text-destructive-text">
              Machine pc2 is offline. Messages will wait until it returns.
            </p>
          </ComposerContextItem>
        ) : null}
      </ComposerContextSources>
      <Row
        contextHost
        submitMode={{ kind: "ready" }}
        initialMessage=""
        stack={
          <>
            {children ? (
              <ThreadChildThreadsBanner
                childThreads={{
                  items: Array.from(
                    { length: children.total + (children.finished ?? 0) },
                    (_, i) => ({
                      id: `child-${i}`,
                      title: SCENE_CHILD_TITLES[i % SCENE_CHILD_TITLES.length]!,
                      href: `/threads/child-${i}`,
                      needsOwnerAttention: i < children.waiting,
                      finished: i >= children.total,
                      updatedAt: STORY_NOW - (i + 1) * 420_000,
                    }),
                  ),
                }}
                isExpanded={false}
                onExpandedChange={noop}
              />
            ) : null}
            {changes || parent ? (
              <GitSegmentFixtureProvider
                key={bannerKey}
                value={{
                  section: dirtyContextBannerSection!,
                  mergeBase: gitSegmentFixtureMergeBase(),
                }}
              >
                <ThreadPromptContextBanner
                  input={{
                    threadId: "thr_story",
                    projectId: "proj_story",
                    environment: null,
                  }}
                  core={{
                    parentThread: parent
                      ? {
                          parentThreadTitle: "OrangeHack",
                          href: "/threads/parent",
                          relationship: "parent",
                        }
                      : null,
                  }}
                  archivedSection={null}
                  environmentGoneSection={null}
                  expandedSegment={null}
                  onToggleSegment={noop}
                />
              </GitSegmentFixtureProvider>
            ) : null}
          </>
        }
      />
    </>
  );
  return (
    <ModelPickerStoryQueryProvider>
      <ComposerContextProvider>
        <div
          className="@container/thread-chat mx-auto flex w-full flex-col justify-end bg-background p-4"
          style={{ height: 760, maxWidth: width ?? 768 }}
        >
          {timeline ? null : (
            <div className="min-h-0 flex-1 overflow-hidden py-3 text-sm">
              <p className="ml-12 rounded-xl bg-muted p-3">
                Проверяю общий overlay и геометрию полосы контекста на плотной
                сцене.
              </p>
            </div>
          )}
          {timeline ? (
            <BottomAnchoredScrollBody
              footer={composer}
              maxWidthClassName="max-w-3xl"
              contentClassName="!pb-3 !pt-4"
            >
              <div className="space-y-3 text-sm">
                {SCENE_TIMELINE.map((line, i) => (
                  <p
                    key={line}
                    className={
                      i % 3 === 0
                        ? "ml-12 rounded-xl bg-muted p-3"
                        : "text-muted-foreground"
                    }
                  >
                    {line}
                  </p>
                ))}
              </div>
            </BottomAnchoredScrollBody>
          ) : (
            composer
          )}
        </div>
      </ComposerContextProvider>
    </ModelPickerStoryQueryProvider>
  );
}
const SCENE_TIMELINE = Array.from(
  { length: 16 },
  (_, i) => `Сообщение ${i + 1}: проверяю, как лента сдвигается вверх.`,
);

export function ContextTimelineShift() {
  return (
    <ContextScene
      timeline
      plan
      questions={1}
      children={{ total: 2, waiting: 2 }}
      changes
      parent
    />
  );
}
export function ContextPlanOnly() {
  return <ContextScene plan />;
}
export function ContextNeedsYouChangesPlan() {
  return (
    <ContextScene
      plan
      questions={1}
      children={{ total: 2, waiting: 2 }}
      changes
      parent
    />
  );
}
export function ContextNineChildren() {
  return <ContextScene children={{ total: 9, waiting: 6, finished: 3 }} />;
}
export function ContextErrorTone() {
  return <ContextScene plan error children={{ total: 1, waiting: 0 }} />;
}
export function ContextNarrow() {
  return (
    <ContextScene
      width={380}
      plan
      questions={1}
      children={{ total: 2, waiting: 2 }}
      changes
    />
  );
}
