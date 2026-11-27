import { type QuestionResolutionAttribution } from "@bb/domain";
import { QuestionResolutionDetails } from "./QuestionResolutionDetails";
import type { ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import {
  QuestionAnswers,
  questionTime,
  questionTitle,
  type QuestionResponseSnapshot,
} from "./question-response-presentation";

export const questionResponseClass =
  "ml-auto min-w-0 w-[calc(100%-0.75rem)] max-w-xl space-y-2 rounded-xl rounded-tr-sm border border-timeline-accent/30 bg-timeline-accent/14 px-3 pt-2.5 pb-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-timeline-accent";

export const questionWithdrawnClass =
  "min-w-0 w-full max-w-xl space-y-2 rounded-xl border border-border bg-transparent px-3 pt-2.5 pb-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-timeline-accent";

export function QuestionResponseBody({
  response,
  timestamp,
  footer,
  resolution,
  quiet = false,
}: {
  response: QuestionResponseSnapshot;
  timestamp?: number;
  footer?: ReactNode;
  resolution?: QuestionResolutionAttribution | null;
  quiet?: boolean;
}) {
  const single = response.publication.questions.length === 1;
  const prompt = response.publication.questions[0]?.prompt
    .replace(/\s+/gu, " ")
    .trim();
  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon
          name={quiet ? "CircleX" : "CircleCheck"}
          className={`size-3.5 shrink-0 ${quiet ? "text-muted-foreground" : "text-timeline-accent"}`}
          aria-hidden="true"
        />
        <span className="font-semibold text-foreground">
          {response.resolution?.action === "withdraw"
            ? "Question withdrawn"
            : "Question response"}
        </span>
        {timestamp !== undefined && Number.isFinite(timestamp) ? (
          <time
            className="ml-auto tabular-nums"
            dateTime={new Date(timestamp).toISOString()}
            title={new Date(timestamp).toLocaleString()}
          >
            {questionTime(timestamp)}
          </time>
        ) : null}
      </div>
      {single ? (
        <blockquote
          title={prompt}
          className={`line-clamp-1 border-l-2 pl-2.5 text-xs text-muted-foreground sm:line-clamp-2 ${quiet ? "border-border" : "border-timeline-accent/40"}`}
        >
          {prompt}
        </blockquote>
      ) : (
        <p className="text-xs text-muted-foreground">
          {questionTitle(response.publication)} ·{" "}
          {response.publication.questions.length} questions
        </p>
      )}
      {resolution ? (
        <QuestionResolutionDetails resolution={resolution} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {response.resolution
            ? "Snapshot · attribution unverified"
            : "Attribution unavailable"}
        </p>
      )}
      {response.decisionPolicy === "local-input-parity" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {response.resolution?.action === "withdraw"
              ? "Local withdrawal · question cancelled"
              : "Local answer · same standing as chat"}
          </p>
          <p>
            Identity is not independently verified. Applies only to this
            question and revision.
          </p>
        </div>
      ) : null}
      {response.resolution?.action !== "withdraw" ? (
        <QuestionAnswers
          publication={response.publication}
          answers={response.answers}
          showPrompts={!single}
        />
      ) : null}
      {footer ? (
        <div
          className={`flex min-h-9 flex-wrap items-center justify-between gap-x-3 border-t text-xs text-muted-foreground pointer-coarse:min-h-11 ${quiet ? "border-border" : "border-timeline-accent/18"}`}
        >
          {footer}
        </div>
      ) : null}
    </>
  );
}
