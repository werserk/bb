import type { ReactNode } from "react";
import { Icon, type IconName } from "@bb/shared-ui/icon";

export function ComposerContextRow({
  icon,
  title,
  subline,
  action,
  secondary,
  tone,
  mono = false,
}: {
  icon: IconName;
  title: ReactNode;
  subline?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  tone?: "attention" | "working";
  mono?: boolean;
}) {
  return (
    <div className="composer-context-row" data-row-tone={tone}>
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <div
        title={typeof title === "string" ? title : undefined}
        className={
          mono
            ? "composer-context-row-title font-mono"
            : "composer-context-row-title"
        }
      >
        {title}
      </div>
      <div className="composer-context-row-actions">
        {action}
        <span className="composer-context-row-secondary">{secondary}</span>
      </div>
      {subline && (
        <div
          className="composer-context-row-subline"
          title={typeof subline === "string" ? subline : undefined}
        >
          {subline}
        </div>
      )}
    </div>
  );
}
