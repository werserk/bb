import { ContextRow, ContextRowIcon } from "@bb/shared-ui/context-row";
import {
  ComposerContextItem,
  useComposerContextSource,
} from "@/components/promptbox/context/composer-context";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useResolvedComposerBanners } from "./composer-slot-hooks";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  composerScopeIdentity,
  useOptionalPluginComposerStaticView,
} from "./plugin-composer-host";

export function ComposerBannersSlot({
  children,
  ownerPlacement = "after",
}: {
  children?: ReactNode;
  ownerPlacement?: "before" | "after";
}) {
  return (
    <ComposerBannerRows ownerPlacement={ownerPlacement}>
      {children}
    </ComposerBannerRows>
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
      <ContextRow
        as="div"
        glyph={<ContextRowIcon name="Blocks" />}
        actionInteractive
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
