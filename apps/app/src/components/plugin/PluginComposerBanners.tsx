import { ComposerContextRow } from "@/components/promptbox/context/ComposerContextRow";
import {
  ComposerContextItem,
  useComposerContextSource,
} from "@/components/promptbox/context/composer-context";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useResolvedComposerBanners } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerStaticView,
} from "./plugin-composer-host";

export function ComposerBannersSlot({
  view,
  children,
  ownerPlacement = "after",
}: {
  view?: ComposerView;
  children?: ReactNode;
  ownerPlacement?: "before" | "after";
}) {
  return view === undefined ? (
    <ComposerBannerRows ownerPlacement={ownerPlacement}>
      {children}
    </ComposerBannerRows>
  ) : (
    <PluginComposerViewProvider value={view}>
      <ComposerBannerRows ownerPlacement={ownerPlacement}>
        {children}
      </ComposerBannerRows>
    </PluginComposerViewProvider>
  );
}

function ComposerBannerRows({
  children,
  ownerPlacement,
}: {
  children?: ReactNode;
  ownerPlacement: "before" | "after";
}) {
  const view = useOptionalPluginComposerStaticView();
  const banners = useResolvedComposerBanners(view?.scope.kind ?? null);
  const scopeKey =
    view === undefined ? null : composerScopeIdentity(view.scope);
  const pluginRows = useMemo(
    () =>
      banners.map(({ key, pluginId, customizationId, banner }) => {
        const slotId = `${customizationId}/${banner.id}`;
        return (
          <PluginSlotMount
            key={`${key}/${scopeKey ?? "unbound"}`}
            pluginId={pluginId}
            slotKind="composerBanner"
            slotId={slotId}
            crashFallback={<></>}
          >
            <ComposerBannerContribution
              pluginId={pluginId}
              slotId={slotId}
              banner={banner}
            />
          </PluginSlotMount>
        );
      }),
    [banners, scopeKey],
  );

  return (
    <>
      {ownerPlacement === "before" ? children : null}
      {pluginRows}
      {ownerPlacement === "after" ? children : null}
    </>
  );
}

function ComposerBannerContribution({
  pluginId,
  slotId,
  banner,
}: {
  pluginId: string;
  slotId: string;
  banner: ReturnType<typeof useResolvedComposerBanners>[number]["banner"];
}) {
  const source = useComposerContextSource();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const content = source ? (
    <div ref={contentRef}>
      <banner.component />
    </div>
  ) : (
    <banner.component />
  );
  const native =
    banner.chrome === "bare" ? (
      content
    ) : (
      <PromptStackCard ariaLabel={pluginId} className="empty:hidden">
        {content}
      </PromptStackCard>
    );
  if (!source) return native;
  return (
    <ComposerContextItem
      id={slotId}
      label={pluginId}
      icon="Info"
      group="context"
      contentRef={contentRef}
    >
      <ComposerContextRow
        icon="Blocks"
        title={pluginId}
        action={
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        }
      />
      <div id={bodyId} hidden={!expanded}>
        {content}
      </div>
    </ComposerContextItem>
  );
}
