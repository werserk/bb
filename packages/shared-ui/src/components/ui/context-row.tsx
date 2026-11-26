import type {
  ComponentPropsWithoutRef,
  ComponentRef,
  ElementType,
  ReactNode,
  Ref,
} from "react";
import { cn } from "../../lib/utils";
import { Icon, type IconName } from "./icon";

export interface ContextProgressValue {
  done: number;
  total: number;
}

const MAX_PROGRESS_SEGMENTS = 8;

export function contextProgressSegments({
  done,
  total,
}: ContextProgressValue): { filled: number; current: boolean; count: number } {
  if (total <= 0) return { filled: 0, current: false, count: 0 };
  const count = Math.min(total, MAX_PROGRESS_SEGMENTS);
  const complete = done >= total;
  const filled = complete
    ? count
    : Math.min(count - 1, Math.floor((Math.max(0, done) / total) * count));
  return { filled, current: !complete, count };
}

export function ContextProgress({
  done,
  total,
  className,
}: ContextProgressValue & { className?: string }) {
  const { filled, current, count } = contextProgressSegments({ done, total });
  if (count === 0) return null;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
      data-context-progress=""
      aria-hidden
    >
      {Array.from({ length: count }, (_, index) => (
        <i
          key={index}
          className={cn(
            "block h-[3px] w-2 rounded-full bg-foreground/15",
            index < filled && "bg-success",
            current && index === filled && "bg-attention",
          )}
        />
      ))}
    </span>
  );
}

export type ContextRowGlyphKind =
  | "question"
  | "needs-you"
  | "working"
  | "done"
  | "current"
  | "idle"
  | "error";

const GLYPH_CLASS: Record<ContextRowGlyphKind, string> = {
  question: "text-attention",
  "needs-you": "text-attention",
  working: "text-muted-foreground",
  done: "text-success",
  current: "text-foreground",
  idle: "text-muted-foreground",
  error: "text-destructive-text",
};

export function ContextRowGlyph({
  kind,
  className,
}: {
  kind: ContextRowGlyphKind;
  className?: string;
}) {
  const classes = cn("size-3.5 shrink-0", GLYPH_CLASS[kind], className);
  if (kind === "working" || kind === "current")
    return (
      <Icon
        name="Loading"
        className={cn(classes, "animate-spin motion-reduce:animate-none")}
        aria-hidden
      />
    );
  return (
    <Icon
      name={
        kind === "done"
          ? "Check"
          : kind === "idle"
            ? "Circle"
            : kind === "error"
              ? "CircleX"
              : "CircleQuestion"
      }
      className={classes}
      aria-hidden
    />
  );
}

export function ContextRowIcon({
  name,
  tone,
}: {
  name: IconName;
  tone?: "attention" | "working";
}) {
  return (
    <Icon
      name={name}
      className={cn(
        "size-3.5 shrink-0",
        tone === "attention" && "text-attention",
        tone === "working" && "text-timeline-accent",
      )}
      aria-hidden
    />
  );
}

export function ContextRowAction({
  variant = "reveal",
  children,
  className,
}: {
  variant?: "primary" | "reveal";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-context-row-action={variant}
      className={cn(
        "inline-flex min-w-16 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs",
        variant === "primary"
          ? "bg-attention font-medium text-attention-foreground"
          : "border border-border text-foreground opacity-0 transition-opacity group-hover/context-row:opacity-100 group-focus-within/context-row:opacity-100",
        className,
      )}
    >
      {children}
    </span>
  );
}

interface ContextRowOwnProps {
  glyph?: ReactNode;
  title: ReactNode;
  subline?: ReactNode;
  secondary?: ReactNode;
  mono?: boolean;
  meta?: ReactNode;
  progress?: ContextProgressValue;
  age?: string;
  action?: ReactNode;
  actionInteractive?: boolean;
  muted?: boolean;
  current?: boolean;
  className?: string;
}

export type ContextRowProps<T extends ElementType = "button"> =
  ContextRowOwnProps & { as?: T; ref?: Ref<ComponentRef<T>> } & Omit<
      ComponentPropsWithoutRef<T>,
      keyof ContextRowOwnProps | "as" | "ref"
    >;

export function ContextRow<T extends ElementType = "button">({
  as,
  glyph,
  title,
  subline,
  secondary,
  mono = false,
  meta,
  progress,
  age,
  action,
  actionInteractive = false,
  muted = false,
  current = false,
  className,
  ...rest
}: ContextRowProps<T>) {
  const Tag: ElementType = as ?? "button";
  const pressable = Tag !== "div";
  const hasMeta =
    meta !== undefined || progress !== undefined || age !== undefined;
  return (
    <div
      data-context-row=""
      data-current={current || undefined}
      className={cn(
        "group/context-row relative flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-xs",
        pressable && "hover:bg-foreground/5 focus-within:bg-foreground/5",
        className,
      )}
    >
      <Tag
        {...(Tag === "button" ? { type: "button" } : {})}
        {...rest}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none",
          pressable &&
            "cursor-pointer before:absolute before:inset-0 before:rounded-md before:content-[''] focus-visible:before:outline focus-visible:before:outline-2 focus-visible:before:outline-ring",
        )}
      >
        {glyph !== undefined ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {glyph}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "block min-w-0 flex-1 truncate font-medium",
                mono && "font-mono",
                muted && "font-normal text-muted-foreground",
                current && "text-foreground",
              )}
            >
              {title}
            </span>
            {hasMeta ? (
              <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                {progress ? (
                  <>
                    <ContextProgress {...progress} />
                    <span className="tabular-nums">
                      {progress.done}/{progress.total}
                    </span>
                  </>
                ) : null}
                {meta !== undefined ? (
                  <span className="max-w-40 truncate">{meta}</span>
                ) : null}
                {age !== undefined ? (
                  <span className="tabular-nums">{age}</span>
                ) : null}
              </span>
            ) : null}
          </span>
          {subline !== undefined ? (
            <span
              className="block min-w-0 truncate text-muted-foreground"
              title={typeof subline === "string" ? subline : undefined}
            >
              {subline}
            </span>
          ) : null}
        </span>
      </Tag>
      {action || secondary ? (
        <span
          data-interactive={actionInteractive || undefined}
          className={cn(
            "pointer-events-none relative z-10 flex shrink-0 items-center gap-2 data-[interactive]:pointer-events-auto",
            actionInteractive &&
              "text-primary [&_:is(button,a)]:min-h-6 [&_:is(button,a)]:cursor-pointer [&_:is(button,a)]:rounded-none [&_:is(button,a)]:border-0 [&_:is(button,a)]:bg-transparent [&_:is(button,a)]:p-0 [&_:is(button,a)]:text-inherit [&_:is(button,a)]:shadow-none [&_:is(button,a):disabled]:opacity-50",
          )}
        >
          {action}
          {secondary ? (
            <span className="text-muted-foreground">{secondary}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
