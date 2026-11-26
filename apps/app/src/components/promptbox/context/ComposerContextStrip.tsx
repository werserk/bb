import { useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ExperimentalComposerContextStripProps } from "@get-bb/plugin-sdk";
import { useComposerContextStore } from "./composer-context";

export function ComposerContextStrip({
  children,
  onAccept,
  onDismiss,
}: ExperimentalComposerContextStripProps) {
  const store = useComposerContextStore();
  const id = useId();
  const [element] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    if (!store) return;
    store.set({
      id,
      sourceId: id,
      element,
      label: "Composer preview",
      icon: "Sparkles",
      group: "context",
      strip: { onAccept, onDismiss },
    });
    return () => store.remove(id);
  }, [store, id, element, onAccept, onDismiss]);
  return store ? createPortal(children, element) : children;
}
