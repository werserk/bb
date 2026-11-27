// The fork-only composer run-row slot (openspec core-run-on-picker, design.md
// "SDK (fork-only, experimental)"). The plugin's SDK does not carry it, so the
// shapes are declared here and the item is registered only when the running
// core offers the slot; a stock core shows nothing new.
import type { ComponentType } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk/app";

export interface ExperimentalComposerRunRowItemProps {
  scope:
    | { kind: "new-thread"; projectId: string | null; providerId: string | null }
    | { kind: "thread"; threadId: string; projectId: string };
  /** At compact widths the item should render icon-first. */
  compact: boolean;
  /**
   * New thread only. This plugin's data for the send's single
   * `pluginSubmission`; null clears it. False when core refuses it.
   */
  setSubmission?(data: JsonValue | null): boolean;
}

export interface ExperimentalComposerRunRowItemRegistration {
  version: 1;
  id: string;
  order?: number;
  component: ComponentType<ExperimentalComposerRunRowItemProps>;
}

type Register = (registration: ExperimentalComposerRunRowItemRegistration) => void;

/** Register the item when `slots` has the run-row slot. True when it did. */
export function registerRunRowItem(
  slots: object,
  registration: ExperimentalComposerRunRowItemRegistration,
): boolean {
  const register = (slots as { experimental_composerRunRowItem?: unknown }).experimental_composerRunRowItem;
  if (typeof register !== "function") return false;
  (register as Register).call(slots, registration);
  return true;
}
