import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type FocusEventHandler,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import * as Popover from "@radix-ui/react-popover";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useComposerContextStore,
  type ComposerContextEntry,
} from "./composer-context";
import "./composer-context.css";

function ContextBody({
  entry,
  visible,
  overview,
}: {
  entry: ComposerContextEntry;
  visible: boolean;
  overview: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = target.current;
    container?.append(entry.element);
    return () => {
      if (entry.element.parentNode === container) entry.element.remove();
    };
  }, [entry.element]);
  return (
    <section
      hidden={!visible}
      data-context-group={entry.group}
      className="composer-context-section"
    >
      {overview && (
        <h3>
          <Icon name={entry.icon} aria-hidden className="size-3.5" />
          {entry.label}
        </h3>
      )}
      <div ref={target} />
    </section>
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
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const summaryButtons = useRef(new Map<string, HTMLButtonElement>());
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const active = entries.find((entry) => entry.id === selected);
  const prioritized = [...entries].sort(
    (a, b) =>
      Number(Boolean(b.overview)) - Number(Boolean(a.overview)) ||
      Number(b.tone === "error") - Number(a.tone === "error") ||
      Number(b.tone === "attention") - Number(a.tone === "attention"),
  );
  const main = prioritized.find((entry) => entry.group === "work");
  const attention = prioritized.find((entry) => entry.group === "attention");
  const bodyEntries = [
    ...(main ? [main] : []),
    ...(attention ? [attention] : []),
    ...entries.filter((entry) => entry !== main && entry !== attention),
  ];
  const overview = active === undefined;
  const open = (id: string | null, button: HTMLButtonElement) => {
    trigger.current = button;
    entries.find((entry) => entry.id === id)?.onReveal?.();
    if (id === null) {
      main?.onReveal?.();
      attention?.onReveal?.();
    }
    setSelected(id);
    setExpanded(true);
  };
  const close = () => {
    setExpanded(false);
    (trigger.current?.isConnected
      ? trigger.current
      : disclosure.current
    )?.focus({ preventScroll: true });
  };
  const toggleSection = (id: string, button: HTMLButtonElement) => {
    if (expanded && active?.id === id) {
      trigger.current = button;
      close();
    } else {
      open(id, button);
    }
  };
  useLayoutEffect(() => {
    if (!store) return;
    const dismiss = () => setExpanded(false);
    return store.connect({
      dismiss,
      reveal: (sourceId) => {
        const entry = store
          .snapshot()
          .find((item) => item.sourceId === sourceId);
        if (!entry) return;
        entry.onReveal?.();
        setSelected(entry.id);
        setExpanded(true);
      },
      blur: onBlurCapture,
    });
  }, [store, onBlurCapture]);
  const hasFacts = entries.length > 0;
  if (!hasFacts && expanded) {
    setExpanded(false);
    setSelected(null);
  }
  const summaryEntries = [...entries]
    .sort(
      (a, b) =>
        Number(b.tone === "error") * 2 +
        Number(b.group === "attention") -
        Number(a.tone === "error") * 2 -
        Number(a.group === "attention"),
    )
    .slice(0, 5);
  return (
    <Popover.Root
      open={expanded && hasFacts}
      onOpenChange={setExpanded}
      modal={false}
    >
      <div
        className="composer-context-dock"
        onBlurCapture={onBlurCapture}
        onKeyDown={(event) => {
          if (expanded && event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        data-context-present={hasFacts || undefined}
        data-context-expanded={(expanded && hasFacts) || undefined}
      >
        {sources}
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={-1}
            avoidCollisions={false}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              close();
            }}
            ref={store?.setPanel ?? panel}
            id={panelId}
            role="region"
            aria-label="Thread context"
            hidden={!expanded || !hasFacts}
            className="composer-context-panel"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            <header className="composer-context-heading">
              {active && (
                <button
                  type="button"
                  aria-label="Back to thread context"
                  onClick={() => setSelected(null)}
                >
                  <Icon name="ChevronLeft" aria-hidden className="size-3.5" />
                </button>
              )}
              <Icon name="Layers" aria-hidden className="size-3.5" />
              <strong>{active?.label ?? "Thread context"}</strong>
              <button
                type="button"
                className="ml-auto"
                aria-label="Collapse thread context"
                title="Collapse thread context (Esc)"
                onClick={close}
              >
                <Icon name="ChevronDown" className="size-3.5" aria-hidden />
              </button>
            </header>
            <div
              className={cn(
                "composer-context-canvas",
                overview && "composer-context-overview",
              )}
            >
              {bodyEntries.map((entry) => (
                <ContextBody
                  key={entry.id}
                  entry={entry}
                  overview={overview}
                  visible={
                    overview
                      ? entry === main ||
                        entry === attention ||
                        (!main && !attention)
                      : entry === active
                  }
                />
              ))}
            </div>
            <footer
              className="composer-context-footer"
              aria-label="All thread context sections"
            >
              {entries
                .filter((entry) => entry !== main && entry !== attention)
                .map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={(event) =>
                      open(
                        entry.id,
                        summaryButtons.current.get(entry.id) ??
                          disclosure.current ??
                          event.currentTarget,
                      )
                    }
                  >
                    <Icon name={entry.icon} className="size-3" aria-hidden />
                    {entry.label}
                    {entry.summary !== undefined && (
                      <span>{entry.summary}</span>
                    )}
                  </button>
                ))}
            </footer>
          </Popover.Content>
        </Popover.Portal>
        {hasFacts && (
          <Popover.Anchor asChild>
            <div
              ref={setSummaryRef}
              className="composer-context-strip"
              role="toolbar"
              aria-label="Thread context summary"
            >
              {summaryEntries.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  ref={(button) => {
                    if (button) summaryButtons.current.set(entry.id, button);
                    else summaryButtons.current.delete(entry.id);
                  }}
                  data-context-count={
                    (entry.summary !== undefined &&
                      entry.group !== "attention" &&
                      entry.tone === undefined) ||
                    undefined
                  }
                  data-context-category={entry.group}
                  aria-label={
                    entry.summary === undefined
                      ? entry.label
                      : `${entry.label}: ${entry.summary}`
                  }
                  aria-controls={panelId}
                  aria-expanded={expanded && active?.id === entry.id}
                  className={cn(
                    entry.tone === "error"
                      ? "text-destructive-text"
                      : entry.tone === "attention"
                        ? "text-attention"
                        : "text-muted-foreground",
                  )}
                  title={`${expanded && active?.id === entry.id ? "Collapse" : "Show"} ${entry.label}`}
                  onClick={(event) =>
                    toggleSection(entry.id, event.currentTarget)
                  }
                >
                  <Icon
                    name={entry.icon}
                    aria-hidden
                    className="size-3.5 shrink-0"
                  />
                  <span>
                    {entry.group === "attention" ||
                    entry.tone !== undefined ||
                    entry.summary === undefined
                      ? entry.label
                      : null}
                    {(entry.group === "attention" ||
                      entry.tone !== undefined) &&
                    entry.summary !== undefined
                      ? " "
                      : null}
                    {entry.summary}
                  </span>
                </button>
              ))}
              <button
                ref={disclosure}
                type="button"
                className="composer-context-disclosure"
                aria-label="Toggle thread context"
                aria-controls={panelId}
                aria-expanded={expanded && hasFacts}
                title={
                  expanded ? "Collapse thread context" : "Show thread context"
                }
                onClick={(event) => {
                  if (expanded) {
                    trigger.current = event.currentTarget;
                    close();
                  } else {
                    open(null, event.currentTarget);
                  }
                }}
              >
                {entries.length > summaryEntries.length && (
                  <span>+{entries.length - summaryEntries.length}</span>
                )}
                <Icon
                  name={expanded ? "ChevronUp" : "ChevronDown"}
                  aria-hidden
                  className="size-3.5"
                />
              </button>
            </div>
          </Popover.Anchor>
        )}
        {children}
      </div>
    </Popover.Root>
  );
}
