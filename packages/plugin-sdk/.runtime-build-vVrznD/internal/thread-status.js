// src/internal/thread-status.ts
var INDICATOR_LABELS = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  "plan-mode": "Plan mode active",
  runtime: "Thread working",
  "queued-failed": "Queued message failed to send",
  "queued-waiting": "Thread has a message waiting to send",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded"
};
var RUNNING_RUNTIME_STATUSES = {
  active: true,
  provisioning: true,
  starting: true,
  stopping: true,
  error: false,
  idle: false,
  pending: false,
  "waiting-for-host": false
};
var DONE_THREAD_STATUSES = {
  error: true,
  idle: true,
  active: false,
  starting: false,
  stopping: false,
  pending: false
};
var INDICATORS_OVER_ROW_STATUS = /* @__PURE__ */ new Set(["runtime", "unread-error", "waiting-for-input"]);
function threadIndicatorLabel(indicator) {
  return indicator === "none" ? null : INDICATOR_LABELS[indicator];
}
function visibleThreadRowStatus(indicator, rowStatus) {
  return INDICATORS_OVER_ROW_STATUS.has(indicator) ? null : rowStatus;
}
function isUnreadDoneThread(thread) {
  return thread.parentThreadId === null && thread.isUnread && DONE_THREAD_STATUSES[thread.status];
}
function addThreadFlags(flags, thread) {
  const unreadDone = isUnreadDoneThread(thread);
  flags.pending ||= thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
  flags.unreadError ||= unreadDone && thread.status === "error";
  flags.unreadSuccess ||= unreadDone && thread.status !== "error";
  flags.runtime ||= RUNNING_RUNTIME_STATUSES[thread.runtimeStatus];
  flags.workflow ||= thread.activity.workflows > 0;
  flags.backgroundAgent ||= thread.activity.backgroundAgents > 0;
  flags.backgroundCommand ||= thread.activity.backgroundCommands > 0;
  flags.planMode ||= thread.activity.planMode > 0;
}
function resolveIndicator(flags, queuedWork, hasUnsubmittedDraft, isWorking) {
  if (flags.unreadError) return "unread-error";
  if (flags.pending) return "waiting-for-input";
  if (hasUnsubmittedDraft && isWorking) return "working-draft";
  if (flags.planMode) return "plan-mode";
  if (flags.runtime) return "runtime";
  if (flags.workflow) return "workflow";
  if (queuedWork === "failed") return "queued-failed";
  if (flags.unreadSuccess) return "unread-success";
  if (flags.backgroundAgent) return "background-agent";
  if (flags.backgroundCommand) return "background-command";
  if (queuedWork === "waiting") return "queued-waiting";
  if (hasUnsubmittedDraft) return "draft";
  return "none";
}
function experimental_resolveThreadStatus({
  thread,
  hiddenThreads,
  hasUnsubmittedDraft,
  rowStatus
}) {
  const flags = {
    pending: false,
    unreadError: false,
    unreadSuccess: false,
    runtime: false,
    workflow: false,
    backgroundAgent: false,
    backgroundCommand: false,
    planMode: false
  };
  if (thread !== null) addThreadFlags(flags, thread);
  for (const hiddenThread of hiddenThreads) addThreadFlags(flags, hiddenThread);
  const isThreadWorking = flags.runtime || flags.workflow || flags.backgroundAgent || flags.backgroundCommand || flags.planMode;
  const indicator = resolveIndicator(
    flags,
    thread?.queuedWork ?? "none",
    hasUnsubmittedDraft,
    isThreadWorking
  );
  const shownRowStatus = visibleThreadRowStatus(indicator, rowStatus);
  return {
    indicator,
    rowStatus: shownRowStatus,
    label: shownRowStatus?.label ?? threadIndicatorLabel(indicator),
    isWorking: isThreadWorking || rowStatus?.tone === "running"
  };
}
export {
  experimental_resolveThreadStatus,
  threadIndicatorLabel,
  visibleThreadRowStatus
};
