import { useResolvedComposerInlinePanels } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  composerScopeIdentity,
  useOptionalPluginComposerStaticView,
} from "./plugin-composer-host";

export function ComposerInlinePanels() {
  const view = useOptionalPluginComposerStaticView();
  const panels = useResolvedComposerInlinePanels(view?.scope.kind ?? null);
  if (!view) return null;
  return (
    <>
      {panels.map(({ key, pluginId, customizationId, panel }) => (
        <PluginSlotMount
          key={`${key}/${composerScopeIdentity(view.scope)}`}
          pluginId={pluginId}
          slotKind="composerInlinePanel"
          slotId={`${customizationId}/${panel.id}`}
          crashFallback={<></>}
        >
          <panel.component />
        </PluginSlotMount>
      ))}
    </>
  );
}
