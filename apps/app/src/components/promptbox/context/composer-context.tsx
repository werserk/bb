import {
  createContext,
  createRef,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
  type FocusEventHandler,
} from "react";
import { createPortal } from "react-dom";
import type { IconName } from "@bb/shared-ui/icon";

export type ComposerContextKind =
  | "needs-you"
  | "working"
  | "plan"
  | "changes"
  | "queue";
export interface ComposerContextProgress {
  done: number;
  total: number;
}
export interface ComposerContextTally {
  added: number;
  removed: number;
}
export interface ComposerContextFact {
  id: string;
  label: string;
  summary?: string | number;
  icon: IconName;
  group: "work" | "attention" | "queue" | "context";
  kind?: ComposerContextKind;
  progress?: ComposerContextProgress;
  tally?: ComposerContextTally;
  tone?: "attention" | "error";
  onReveal?: () => void;
}
export interface ComposerContextEntry extends ComposerContextFact {
  element: HTMLDivElement;
  sourceId: string;
  strip?: { onAccept?(): void; onDismiss(): void };
}
export class ComposerContextStore {
  private entries = new Map<string, ComposerContextEntry>();
  private current: readonly ComposerContextEntry[] = [];
  anchor = createRef<HTMLDivElement>();
  panel = createRef<HTMLDivElement>();
  private onBlurCapture: FocusEventHandler<HTMLDivElement> | undefined;
  blur: FocusEventHandler<HTMLDivElement> = (event) =>
    this.onBlurCapture?.(event);
  setAnchor = (element: HTMLDivElement | null) => {
    this.anchor.current = element;
  };
  setPanel = (element: HTMLDivElement | null) => {
    this.panel.current = element;
  };
  contains = (target: Node | null) =>
    Boolean(
      target &&
      (this.anchor.current?.contains(target) ||
        this.panel.current?.contains(target)),
    );
  private onReveal: ((sourceId: string) => void) | null = null;
  reveal = (sourceId: string) => this.onReveal?.(sourceId);
  private onDismiss: (() => void) | null = null;
  dismiss = () => this.onDismiss?.();
  previewKey = (key: "Tab" | "Escape") => {
    const preview = this.current.find((entry) => entry.strip)?.strip;
    if (!preview) return false;
    if (key === "Tab") {
      if (!preview.onAccept) return false;
      preview.onAccept();
    } else {
      preview.onDismiss();
      this.dismiss();
    }
    return true;
  };
  connect(handlers: {
    dismiss: () => void;
    reveal: (sourceId: string) => void;
    blur: FocusEventHandler<HTMLDivElement> | undefined;
  }) {
    this.onDismiss = handlers.dismiss;
    this.onReveal = handlers.reveal;
    this.onBlurCapture = handlers.blur;
    return () => {
      if (this.onDismiss !== handlers.dismiss) return;
      this.onDismiss = null;
      this.onReveal = null;
      this.onBlurCapture = undefined;
    };
  }
  private listeners = new Set<() => void>();
  snapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(entry: ComposerContextEntry) {
    this.entries.set(entry.id, entry);
    this.publish();
  }
  remove(id: string) {
    if (this.entries.delete(id)) this.publish();
  }
  private publish() {
    this.current = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}
const StoreContext = createContext<ComposerContextStore | null>(null);
const SourceContext = createContext<ComposerContextStore | null>(null);
export const useComposerContextStore = () => useContext(StoreContext);
export const useComposerContextSource = () => useContext(SourceContext);
export function ComposerContextProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ComposerContextStore());
  return (
    <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
  );
}
export function ComposerContextSources({ children }: { children: ReactNode }) {
  const store = useComposerContextStore();
  return (
    <SourceContext.Provider value={store}>
      {store ? <div hidden>{children}</div> : children}
    </SourceContext.Provider>
  );
}
export function ComposerContextItem({
  children,
  contentRef,
  ...fact
}: ComposerContextFact & {
  children: ReactNode;
  contentRef?: RefObject<HTMLDivElement | null>;
}) {
  const store = useComposerContextSource();
  const instanceId = useId();
  const {
    id: sourceId,
    label,
    summary,
    icon,
    group,
    kind,
    progress,
    tally,
    tone,
    onReveal,
  } = fact;
  const progressDone = progress?.done;
  const progressTotal = progress?.total;
  const tallyAdded = tally?.added;
  const tallyRemoved = tally?.removed;
  const id = `${sourceId}/${instanceId}`;
  const [element] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  useLayoutEffect(() => {
    if (!store || !element) return;
    const content = contentRef?.current;
    let present = content ? content.hasChildNodes() : contentRef === undefined;
    const update = () => {
      if (present)
        store.set({
          id,
          sourceId,
          element,
          label,
          summary,
          icon,
          group,
          kind,
          progress:
            progressDone === undefined || progressTotal === undefined
              ? undefined
              : { done: progressDone, total: progressTotal },
          tally:
            tallyAdded === undefined || tallyRemoved === undefined
              ? undefined
              : { added: tallyAdded, removed: tallyRemoved },
          tone,
          onReveal,
        });
      else store.remove(id);
    };
    update();
    if (!content) return;
    const observer = new MutationObserver(() => {
      const next = content.hasChildNodes();
      if (next === present) return;
      present = next;
      update();
    });
    observer.observe(content, { childList: true });
    return () => observer.disconnect();
  }, [
    store,
    element,
    contentRef,
    id,
    sourceId,
    label,
    summary,
    icon,
    group,
    kind,
    progressDone,
    progressTotal,
    tallyAdded,
    tallyRemoved,
    tone,
    onReveal,
  ]);
  useLayoutEffect(
    () => () => {
      store?.remove(id);
    },
    [store, id],
  );
  if (!store || !element) return children;
  return createPortal(
    <StoreContext.Provider value={null}>
      <SourceContext.Provider value={null}>
        <div onBlurCapture={store.blur}>{children}</div>
      </SourceContext.Provider>
    </StoreContext.Provider>,
    element,
  );
}
