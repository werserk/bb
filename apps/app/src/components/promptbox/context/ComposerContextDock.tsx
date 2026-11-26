import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type FocusEventHandler,
  type KeyboardEvent,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { formatDiffCount } from "@bb/thread-view";
import { ContextProgress } from "@bb/shared-ui/context-row";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useComposerContextStore,
  type ComposerContextEntry,
  type ComposerContextTally,
} from "./composer-context";
import {
  groupComposerContext,
  type ComposerContextGroup,
} from "./composer-context-groups";
import "./composer-context.css";

const COMPOSER_INPUT_SELECTOR =
  'textarea, [contenteditable="true"], [role="textbox"]';
const SECTION_SCROLL_PADDING = 6;
const CANVAS_BOTTOM_PADDING = 8;

function ContextBody({
  entry,
  onExpand,
}: {
  entry: ComposerContextEntry;
  onExpand?: (element: HTMLElement) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = target.current;
    container?.append(entry.element);
    return () => {
      if (entry.element.parentNode === container) entry.element.remove();
    };
  }, [entry.element]);
  useLayoutEffect(() => {
    const node = target.current;
    if (!node || !onExpand) return;
    const click = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input")
      )
        return;
      onExpand(node);
    };
    node.addEventListener("click", click);
    return () => node.removeEventListener("click", click);
  }, [onExpand]);
  return (
    <div
      data-context-group={entry.group}
      data-context-tone={entry.tone}
      className="composer-context-body"
    >
      <div ref={target} />
    </div>
  );
}

function positionWithin(canvas: HTMLElement, element: HTMLElement) {
  return (
    element.getBoundingClientRect().top -
    canvas.getBoundingClientRect().top +
    canvas.scrollTop
  );
}

function fitRows(canvas: HTMLElement) {
  canvas.style.height = "";
  if (canvas.scrollHeight <= canvas.clientHeight + 1) return;
  const limit = canvas.scrollTop + canvas.clientHeight - CANVAS_BOTTOM_PADDING;
  let bottom = 0;
  let nextTop = Number.POSITIVE_INFINITY;
  for (const row of canvas.querySelectorAll<HTMLElement>(
    "[data-context-row], [data-context-heading], [data-context-fit]",
  )) {
    const top = positionWithin(canvas, row);
    const rowBottom = top + row.offsetHeight;
    if (rowBottom <= limit) {
      if (rowBottom > bottom) bottom = rowBottom;
    } else if (top < nextTop) {
      nextTop = top;
    }
  }
  if (bottom - canvas.scrollTop < 48) return;
  const end = Math.max(
    bottom,
    Math.min(bottom + CANVAS_BOTTOM_PADDING, nextTop),
  );
  canvas.style.height = `${end - canvas.scrollTop}px`;
}

function scrollToSection(canvas: HTMLElement, key: string | null) {
  const section =
    key === null
      ? null
      : [
          ...canvas.querySelectorAll<HTMLElement>("[data-context-section]"),
        ].find((candidate) => candidate.dataset.contextSection === key);
  canvas.style.height = "";
  canvas.scrollTop = section
    ? Math.max(0, positionWithin(canvas, section) - SECTION_SCROLL_PADDING)
    : 0;
  fitRows(canvas);
}

function ChangesTally({ tally }: { tally: ComposerContextTally | undefined }) {
  if (!tally) return null;
  return (
    <span className="composer-context-count composer-context-diff">
      <span className="text-diff-added">+{formatDiffCount(tally.added)}</span>{" "}
      <span className="text-diff-removed">
        −{formatDiffCount(tally.removed)}
      </span>
    </span>
  );
}

function groupAriaLabel(group: ComposerContextGroup, tally: string | null) {
  const detail = tally ?? group.count;
  return detail === undefined || detail === null
    ? group.label
    : `${group.label}: ${detail}`;
}

function GroupChip({
  group,
  panelId,
  selected,
  buttonRef,
  onClick,
}: {
  group: ComposerContextGroup;
  panelId: string;
  selected: boolean;
  buttonRef: (button: HTMLButtonElement | null) => void;
  onClick: (button: HTMLButtonElement) => void;
}) {
  const tally = group.kind === "changes" ? group.tally : undefined;
  const tallyText = tally
    ? `+${formatDiffCount(tally.added)} −${formatDiffCount(tally.removed)}`
    : null;
  return (
    <button
      type="button"
      ref={buttonRef}
      data-context-tone={group.tone}
      data-context-category={group.kind}
      aria-label={groupAriaLabel(group, tallyText)}
      aria-controls={panelId}
      aria-expanded={selected}
      className={cn(
        group.tone === "error"
          ? "text-destructive-text"
          : group.tone === "attention"
            ? "text-attention"
            : "text-muted-foreground",
      )}
      title={`${selected ? "Collapse" : "Show"} ${group.label}`}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {group.kind === "plan" && group.progress ? (
        <ContextProgress {...group.progress} />
      ) : null}
      <span data-context-glyph="" className="inline-flex">
        <Icon
          name={group.icon}
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            group.kind === "working" &&
              "animate-spin motion-reduce:animate-none",
          )}
        />
      </span>
      <span className="composer-context-label">{group.label}</span>
      {group.kind === "changes" ? (
        <ChangesTally tally={tally} />
      ) : group.count !== undefined ? (
        <span className="composer-context-count">{group.count}</span>
      ) : null}
    </button>
  );
}

const EMPTY: readonly ComposerContextEntry[] = [];
const noopSubscribe = () => () => {};
export function ComposerContextDock({
  children,
  sources,
  summaryRef,
  onBlurCapture,
}: {
  children: ReactNode;
  sources?: ReactNode;
  summaryRef?: Ref<HTMLDivElement>;
  onBlurCapture?: FocusEventHandler<HTMLDivElement>;
}) {
  const store = useComposerContextStore();
  const setSummaryRef = useComposedRefs(store?.setAnchor, summaryRef);
  const entries = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? (() => EMPTY),
    () => EMPTY,
  );
  const helper = entries.find((entry) => entry.strip);
  const groups = useMemo(
    () => groupComposerContext(entries.filter((entry) => !entry.strip)),
    [entries],
  );
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const chipButtons = useRef(new Map<string, HTMLButtonElement>());
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const setPanelRef = useComposedRefs(store?.setPanel, panel);
  const hasFacts = entries.length > 0;
  const open = hasFacts && expanded;
  const active = groups.find((group) => group.key === selected);
  const sectionKey = active?.key ?? null;

  const focusInput = useCallback(() => {
    const input = dock.current?.querySelector<HTMLElement>(
      COMPOSER_INPUT_SELECTOR,
    );
    if (input) {
      input.focus({ preventScroll: true });
      return true;
    }
    return false;
  }, []);
  const close = useCallback(
    (returnFocus: boolean) => {
      setExpanded(false);
      if (!returnFocus) return;
      if (focusInput()) return;
      (trigger.current?.isConnected
        ? trigger.current
        : disclosure.current
      )?.focus({ preventScroll: true });
    },
    [focusInput],
  );
  const reveal = (key: string | null, button: HTMLElement | null) => {
    trigger.current = button;
    for (const group of groups) {
      if (key === null || group.key === key)
        for (const entry of group.entries) entry.onReveal?.();
    }
    setSelected(key);
    setExpanded(true);
  };
  const expandPreview = (element: HTMLElement) => {
    trigger.current = element;
    helper?.onReveal?.();
    setSelected(null);
    setExpanded(true);
  };
  const toggleGroup = (key: string, button: HTMLButtonElement) => {
    if (open && sectionKey === key) {
      trigger.current = button;
      close(true);
    } else {
      reveal(key, button);
    }
  };

  useLayoutEffect(() => {
    if (!store) return;
    const dismiss = () => setExpanded(false);
    return store.connect({
      dismiss,
      reveal: (sourceId) => {
        const group = groupComposerContext(
          store.snapshot().filter((entry) => !entry.strip),
        ).find((candidate) =>
          candidate.entries.some((entry) => entry.sourceId === sourceId),
        );
        if (!group) return;
        for (const entry of group.entries)
          if (entry.sourceId === sourceId) entry.onReveal?.();
        trigger.current =
          chipButtons.current.get(group.key) ?? disclosure.current;
        setSelected(group.key);
        setExpanded(true);
      },
      blur: onBlurCapture,
    });
  }, [store, onBlurCapture]);

  const escape = useRef<() => void>(() => {});
  escape.current = () => {
    helper?.strip?.onDismiss();
    close(true);
  };
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      escape.current();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (canvas && open) scrollToSection(canvas, sectionKey);
  }, [canvas, open, sectionKey]);
  useEffect(() => {
    if (!canvas || !open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitRows(canvas));
    for (const child of canvas.children) observer.observe(child);
    return () => observer.disconnect();
  }, [canvas, open, groups, helper]);

  if (!hasFacts && expanded) {
    setExpanded(false);
    setSelected(null);
  }

  const onToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const index =
      event.target instanceof HTMLButtonElement
        ? buttons.indexOf(event.target)
        : -1;
    if (index < 0) return;
    event.preventDefault();
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + direction + buttons.length) % buttons.length
    ]?.focus();
  };

  return (
    <div
      ref={dock}
      className="composer-context-dock"
      onBlurCapture={onBlurCapture}
      data-context-present={hasFacts || undefined}
      data-context-expanded={open || undefined}
    >
      {sources}
      {open && (
        <div
          ref={setPanelRef}
          id={panelId}
          role="region"
          aria-label="Thread context"
          className="composer-context-panel"
        >
          <div ref={setCanvas} className="composer-context-canvas">
            {helper && (
              <section
                data-context-helper=""
                className="composer-context-section"
              >
                <ContextBody entry={helper} />
              </section>
            )}
            {groups.map((group) => (
              <section
                key={group.key}
                data-context-section={group.key}
                data-context-kind={group.kind}
                data-context-tone={group.tone}
                aria-labelledby={`${panelId}-${group.key}`}
                className="composer-context-section"
              >
                <h3
                  id={`${panelId}-${group.key}`}
                  data-context-heading=""
                  className="composer-context-heading"
                >
                  <span>{group.label}</span>
                  {group.count !== undefined && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="composer-context-heading-count">
                        {group.count}
                      </span>
                    </>
                  )}
                </h3>
                {group.entries.map((entry) => (
                  <ContextBody key={entry.id} entry={entry} />
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
      {hasFacts && (
        <div
          ref={setSummaryRef}
          className="composer-context-strip"
          data-context-helper={Boolean(helper) || undefined}
          role="toolbar"
          aria-label="Thread context summary"
          onKeyDown={onToolbarKeyDown}
        >
          {helper && !open && (
            <div
              className="composer-context-preview"
              tabIndex={0}
              role="group"
              aria-label="Composer preview"
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  expandPreview(event.currentTarget);
                }
              }}
            >
              <ContextBody entry={helper} onExpand={expandPreview} />
            </div>
          )}
          <div className="composer-context-tabs">
            {groups.map((group) => (
              <GroupChip
                key={group.key}
                group={group}
                panelId={panelId}
                selected={open && sectionKey === group.key}
                buttonRef={(button) => {
                  if (button) chipButtons.current.set(group.key, button);
                  else chipButtons.current.delete(group.key);
                }}
                onClick={(button) => toggleGroup(group.key, button)}
              />
            ))}
          </div>
          {groups.length >= 2 && (
            <button
              ref={disclosure}
              type="button"
              className="composer-context-disclosure"
              aria-label="All thread context"
              aria-controls={panelId}
              aria-expanded={open && sectionKey === null}
              title={
                open && sectionKey === null
                  ? "Collapse thread context"
                  : "Show all thread context"
              }
              onClick={(event) => {
                if (open && sectionKey === null) {
                  trigger.current = event.currentTarget;
                  close(true);
                } else {
                  reveal(null, event.currentTarget);
                }
              }}
            >
              <span className="composer-context-label">All</span>
              <Icon
                name="ChevronDown"
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform",
                  !(open && sectionKey === null) && "rotate-180",
                )}
              />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
