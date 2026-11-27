import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import type {
  ExperimentalComposerRunRowItemScope,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  usePluginSlotKind,
  type PluginComposerRunRowItemSlot,
} from "@/lib/plugin-slots";
import type { PluginSubmission } from "./submission";

export const RUN_ROW_COMPACT_QUERY = "(max-width: 30rem)";

function byOrder(
  left: PluginComposerRunRowItemSlot,
  right: PluginComposerRunRowItemSlot,
): number {
  return (
    (left.order ?? 0) - (right.order ?? 0) ||
    left.pluginId.localeCompare(right.pluginId) ||
    left.id.localeCompare(right.id)
  );
}

export function sortRunRowItems(
  items: readonly PluginComposerRunRowItemSlot[],
): PluginComposerRunRowItemSlot[] {
  return [...items].sort(byOrder);
}

export function ComposerRunRowItems({
  scope,
  submission = null,
  setSubmissionFor,
}: {
  scope: ExperimentalComposerRunRowItemScope;
  submission?: PluginSubmission | null;
  setSubmissionFor?: (pluginId: string, data: JsonValue | null) => boolean;
}) {
  const items = usePluginSlotKind("composerRunRowItems");
  const compact = useMediaQuery(RUN_ROW_COMPACT_QUERY);
  if (items.length === 0) return null;
  return (
    <>
      {sortRunRowItems(items).map((item) => {
        const Item = item.component;
        return (
          <PluginSlotMount
            key={`${item.pluginId}:${item.generation}:${item.id}`}
            pluginId={item.pluginId}
            slotKind="composerRunRowItem"
            slotId={item.id}
            crashFallback={null}
          >
            <Item
              scope={scope}
              compact={compact}
              {...(setSubmissionFor === undefined
                ? {}
                : {
                    submission:
                      submission?.pluginId === item.pluginId
                        ? submission.data
                        : null,
                    setSubmission: (data: JsonValue | null) =>
                      setSubmissionFor(item.pluginId, data),
                  })}
            />
          </PluginSlotMount>
        );
      })}
    </>
  );
}
