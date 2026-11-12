import {
  questionResolutionLabel,
  type QuestionResolutionAttribution,
} from "@bb/domain";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { getThreadRoutePath } from "@/lib/route-paths";
import { questionTime } from "./question-response-presentation";

export function QuestionResolutionDetails({
  resolution,
  showIdentity = false,
}: {
  resolution: QuestionResolutionAttribution | null;
  showIdentity?: boolean;
}) {
  if (!resolution)
    return (
      <p className="text-xs text-muted-foreground">Attribution unavailable</p>
    );
  const actor = resolution.actor;
  const label = questionResolutionLabel(resolution);
  return (
    <div className="min-w-0 space-y-1 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {actor.kind === "agent" ? (
          <RouteAnchor
            href={getThreadRoutePath({
              projectId: actor.projectId,
              threadId: actor.threadId,
            })}
            className="min-w-0 break-words font-medium underline decoration-muted-foreground/40 underline-offset-2"
          >
            {label}
          </RouteAnchor>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        <time
          className="text-muted-foreground"
          dateTime={new Date(resolution.acceptedAt).toISOString()}
        >
          {questionTime(resolution.acceptedAt)}
        </time>
      </div>
      {resolution.reason.length > 180 ? (
        <details>
          <summary className="cursor-pointer break-words text-muted-foreground">
            {resolution.reason.slice(0, 160)}… · Full reason
          </summary>
          <p className="whitespace-pre-wrap break-words pt-1">
            {resolution.reason}
          </p>
        </details>
      ) : (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {resolution.reason}
        </p>
      )}
      {showIdentity && actor.kind === "agent" ? (
        <p className="break-words text-muted-foreground">
          Recorded actor: {actor.name || "Agent"} · {actor.threadId}
          {actor.role ? ` · ${actor.role}` : ""}
        </p>
      ) : null}
    </div>
  );
}
