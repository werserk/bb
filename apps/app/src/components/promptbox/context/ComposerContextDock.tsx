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
  onExpand,
}: {
  entry: ComposerContextEntry;
  visible: boolean;
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
    <section
      data-context-id={entry.id}
      hidden={!visible}
      data-context-group={entry.group}
      data-context-tone={entry.tone}
      className="composer-context-section"
    >
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
  const trigger = useRef<HTMLElement | null>(null);
  const summaryButtons = useRef(new Map<string, HTMLButtonElement>());
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const helper = entries.find((entry) => entry.strip);
  const facts = entries.filter((entry) => !entry.strip);
  const active = entries.find((entry) => entry.id === selected);
  const prioritized = [...facts].sort(
    (a, b) =>
      Number(Boolean(b.overview)) - Number(Boolean(a.overview)) ||
      Number(b.tone === "error") - Number(a.tone === "error") ||
      Number(b.tone === "attention") - Number(a.tone === "attention"),
  );
  const main =
    prioritized.find((entry) => entry.group === "work") ??
    prioritized.find((entry) => entry.group !== "attention");
  const attention = prioritized.find((entry) => entry.group === "attention");
  const bodyEntries = [
    ...(attention ? [attention] : []),
    ...(main ? [main] : []),
    ...facts.filter((entry) => entry !== main && entry !== attention),
  ];
  const overview = active === undefined;
  const open = (id: string | null, button: HTMLElement) => {
    trigger.current = button;
    entries.find((entry) => entry.id === id)?.onReveal?.();
    if (id === null) {
      main?.onReveal?.();
      attention?.onReveal?.();
    }
    setSelected(id);
    setExpanded(true);
    requestAnimationFrame(() => {
      const section = store?.panel.current?.querySelector<HTMLElement>(
        `[data-context-id="${(id ?? "").replaceAll('"', '\\"')}"]`,
      );
      section?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const close = () => {
    setExpanded(false);
    const target = trigger.current?.isConnected
      ? trigger.current
      : (root.current?.querySelector<HTMLElement>(
          '[contenteditable="true"], textarea',
        ) ?? summaryButtons.current.values().next().value);
    target?.focus({ preventScroll: true });
  };
  const toggleSection = (id: string, button: HTMLElement) => {
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
        trigger.current = summaryButtons.current.get(entry.id) ?? null;
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
  const summaryEntries = [...facts].sort(
    (a, b) =>
      Number(b.tone === "error") * 2 +
      Number(b.group === "attention") -
      Number(a.tone === "error") * 2 -
      Number(a.group === "attention"),
  );
  return (
    <Popover.Root
      open={expanded && hasFacts}
      onOpenChange={setExpanded}
      modal={false}
    >
      <div
        ref={root}
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
              helper?.strip?.onDismiss();
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
            <div
              className={cn(
                "composer-context-canvas",
                overview && "composer-context-overview",
              )}
            >
              {helper && <ContextBody entry={helper} visible />}
              {bodyEntries.map((entry) => (
                <ContextBody key={entry.id} entry={entry} visible />
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
        {hasFacts && (
          <Popover.Anchor asChild>
            <div
              ref={setSummaryRef}
              className="composer-context-strip"
              data-context-helper={Boolean(helper) || undefined}
              role="toolbar"
              aria-label="Thread context summary"
            >
              {helper && !expanded && (
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
                      open(helper.id, event.currentTarget);
                    }
                  }}
                >
                  <ContextBody
                    entry={helper}
                    visible
                    onExpand={(element) => open(helper.id, element)}
                  />
                </div>
              )}
              <div
                className="composer-context-tabs"
                onKeyDown={(event) => {
                  const direction =
                    event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : 0;
                  if (!direction && event.key !== "Home" && event.key !== "End")
                    return;
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button",
                    ),
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
                }}
              >
                {summaryEntries.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    ref={(button) => {
                      if (button) summaryButtons.current.set(entry.id, button);
                      else summaryButtons.current.delete(entry.id);
                    }}
                    data-context-tone={entry.tone}
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
                    onClick={(event) =>
                      toggleSection(entry.id, event.currentTarget)
                    }
                  >
                    <Icon
                      name={entry.icon}
                      aria-hidden
                      className="size-3.5 shrink-0"
                    />
                    <span className="composer-context-label">
                      {entry.label}
                    </span>
                    {entry.summary !== undefined && (
                      <span className="composer-context-count">
                        {entry.summary}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Popover.Anchor>
        )}
        {children}
      </div>
    </Popover.Root>
  );
}
