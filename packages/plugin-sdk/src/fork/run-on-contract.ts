import type { ComponentType } from "react";
import type { JsonValue } from "../json-value.js";

/**
 * Presents one of this plugin's own environment providers in the New Thread
 * "Run on" menu as `agent → workspace` choices, and the open thread's
 * environment as the same chip. Core ignores a registration whose provider is
 * not owned by the registering plugin.
 */
export interface ExperimentalRunOnProviderRegistration {
  /** Core mounts only versions it knows and warns once for others. */
  version: 1;
  /** One of this plugin's own environment providers. */
  environmentProviderId: string;
  /** Group heading, e.g. "On a worker". */
  title: string;
  /** Group line, e.g. "agent there, files on machine-a". */
  description?: string;
  /** Lower first; groups follow the Local machines group. */
  order?: number;
  /**
   * Choices for a new thread in this project. A React hook: core calls it
   * inside the plugin's boundary.
   */
  useChoices(scope: { projectId: string }): ExperimentalRunOnChoices;
  /** The workspace of an open thread created by this provider. A React hook. */
  useThreadWorkspace(scope: {
    threadId: string;
    inputs: JsonValue | null;
  }): ExperimentalRunOnWorkspace | null;
  /** Optional actions under core's details in the open-thread popover. */
  ThreadActions?: ComponentType<{ threadId: string }>;
}

export interface ExperimentalRunOnChoices {
  status: "loading" | "ready" | "error";
  choices: readonly ExperimentalRunOnChoice[];
  error?: string;
}

export interface ExperimentalRunOnChoice {
  /** Stable within the registration; core remembers it per project. */
  id: string;
  /** The machine the provider runs on; core selects the provider there. */
  agentHostId: string;
  /** The provider inputs this choice submits; core seeds the stock inputs state with it. */
  inputs: JsonValue;
  workspace: ExperimentalRunOnWorkspace;
  /** A plugin-level reason; host offline and provider availability are core's to compute. */
  disabledReason?: string | null;
}

export interface ExperimentalRunOnWorkspace {
  /** The bb host that holds the files; core derives its name and online state. */
  hostId: string | null;
  /** Chip label when `hostId` is not a known host. */
  label?: string;
  /** Menu footer and popover, e.g. the path. */
  detail?: string;
  /** The workspace's current branch, shown by the branch chip. */
  branch?: string | null;
  /** Set when the plugin knows the thread cannot run as bound, e.g. "Workspace unbound". */
  issue?: string | null;
}

/**
 * An item in the row under the composer. Every item sits after the Run on
 * chip; `order` sorts items among themselves only.
 */
export interface ExperimentalComposerRunRowItemRegistration {
  version: 1;
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /**
   * Lower first among row items; default 0; ties by plugin id, then item id.
   * Leave gaps (e.g. 10, 20) so other plugins can sit between.
   */
  order?: number;
  component: ComponentType<ExperimentalComposerRunRowItemProps>;
}

export type ExperimentalComposerRunRowItemScope =
  | { kind: "new-thread"; projectId: string | null; providerId: string | null }
  | { kind: "thread"; threadId: string; projectId: string };

export interface ExperimentalComposerRunRowItemProps {
  scope: ExperimentalComposerRunRowItemScope;
  /** At compact widths the item should render icon-first. */
  compact: boolean;
  /**
   * New thread only. The data core holds for this plugin in the draft, or
   * null. Read it on mount to restore a pick after a remount.
   */
  submission?: JsonValue | null;
  /**
   * New thread only. This plugin's data for the send's single
   * `pluginSubmission`; null clears it. Returns false when it is refused
   * (another plugin holds it, or the JSON is over 16 KB). Core drops it after
   * a successful create (a refused or failed create keeps it with the draft)
   * and on a project or agent provider change. A plain function: safe to call
   * detached.
   */
  setSubmission?: (data: JsonValue | null) => boolean;
}
