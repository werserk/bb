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

export function QuestionResponseBody({
  response,
  timestamp,
  footer,
}: {
  response: QuestionResponseSnapshot;
  timestamp?: number;
  footer?: ReactNode;
}) {
  const single = response.publication.questions.length === 1;
  const prompt = response.publication.questions[0]?.prompt
    .replace(/\s+/gu, " ")
    .trim();
  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon
          name="CircleCheck"
          className="size-3.5 shrink-0 text-timeline-accent"
          aria-hidden="true"
        />
        <span className="font-semibold text-foreground">You answered</span>
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
          className="line-clamp-1 border-l-2 border-timeline-accent/40 pl-2.5 text-xs text-muted-foreground sm:line-clamp-2"
        >
          {prompt}
        </blockquote>
      ) : (
        <p className="text-xs text-muted-foreground">
          {questionTitle(response.publication)} ·{" "}
          {response.publication.questions.length} questions
        </p>
      )}
      <QuestionAnswers
        publication={response.publication}
        answers={response.answers}
        showPrompts={!single}
      />
      {footer ? (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 border-t border-timeline-accent/18 text-xs text-muted-foreground pointer-coarse:min-h-11">
          {footer}
        </div>
      ) : null}
    </>
  );
}
