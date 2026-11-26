import { useId, useState } from "react";
import type { ExperimentalCollapsibleStackCardProps } from "@get-bb/plugin-sdk";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import { CollapsibleActiveStackCard } from "@/components/promptbox/banner/CollapsibleActiveStackCard";
import type { ComposerContextKind } from "@/components/promptbox/context/composer-context";
import { showMutationErrorToast } from "@/lib/mutation-errors";

export function CollapsibleStackCard(
  props: ExperimentalCollapsibleStackCardProps,
) {
  return (
    <CoreCollapsibleStackCard
      {...props}
      contextKind={props.isActive ? "working" : undefined}
    />
  );
}

export function CoreCollapsibleStackCard({
  label,
  title,
  icon,
  isActive,
  contextKind,
  dismiss,
  children,
}: ExperimentalCollapsibleStackCardProps & {
  contextKind?: ComposerContextKind;
}) {
  const id = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissPending, setIsDismissPending] = useState(false);
  return (
    <CollapsibleActiveStackCard
      cardAriaLabel={label}
      controlsAriaLabel={`${label} controls`}
      toggleId={`${id}-toggle`}
      bodyId={`${id}-body`}
      toggleAriaLabel={label}
      iconName={pluginIconName(icon)}
      title={title}
      isActive={isActive}
      contextKind={contextKind}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((value) => !value)}
      dismiss={
        dismiss === undefined
          ? null
          : {
              ariaLabel: dismiss.label,
              isPending: isDismissPending,
              onDismiss: () => {
                setIsDismissPending(true);
                dismiss
                  .onDismiss()
                  .catch((error: unknown) => {
                    showMutationErrorToast({
                      error,
                      fallbackMessage: dismiss.failureMessage,
                    });
                  })
                  .finally(() => setIsDismissPending(false));
              },
            }
      }
    >
      {children}
    </CollapsibleActiveStackCard>
  );
}
