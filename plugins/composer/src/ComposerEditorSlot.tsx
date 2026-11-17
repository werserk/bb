import { useLayoutEffect, useState, type RefObject } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";
import {
  PromptMentionLinkContext,
  type PromptMentionLinkResolver,
} from "./editor/prompt-mention-link";

export const COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY =
  "--composer-editor-available-height";

export type ComposerEditorLayout = "thread" | "root-compose";

export function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

export function ComposerEditorSlot({
  editor,
  scrollContainerRef,
  inputLocked,
  isCompactLayout,
  suggestionVisible,
  minHeight,
  layout,
  resolveMentionLink,
  expanded,
  onExpandedChange,
}: {
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  editor: Editor | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  inputLocked: boolean;
  isCompactLayout: boolean;
  suggestionVisible: boolean;
  minHeight: number;
  layout: ComposerEditorLayout;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
}) {
  const [moreLines, setMoreLines] = useState(0);
  useLayoutEffect(() => {
    const scroll = scrollContainerRef.current;
    if (!scroll || !editor) return;
    const measure = () => {
      const line =
        Number.parseFloat(getComputedStyle(editor.view.dom).lineHeight) || 24;
      setMoreLines(
        Math.max(
          0,
          Math.ceil((scroll.scrollHeight - scroll.clientHeight) / line),
        ),
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(scroll);
    observer?.observe(editor.view.dom);
    editor.on("update", measure);
    return () => {
      observer?.disconnect();
      editor.off("update", measure);
    };
  }, [editor, expanded, isCompactLayout, scrollContainerRef]);
  return (
    <>
      <div
        ref={scrollContainerRef}
        data-promptbox-editor-scroll=""
        data-editor-layout={layout}
        aria-busy={inputLocked || undefined}
        className={cn(
          "w-full overflow-y-auto bg-transparent px-4 pb-1 pr-14 pt-3 outline-none",
          COARSE_POINTER_TEXT_BASE_CLASS,
          "leading-relaxed",
          isCompactLayout && "h-12 overflow-hidden pb-0 pr-2 pt-0",
        )}
        style={{
          minHeight: isCompactLayout ? "48px" : `${minHeight}px`,
          height: isCompactLayout ? "48px" : undefined,
          maxHeight: isCompactLayout
            ? "48px"
            : expanded
              ? undefined
              : `min(var(--composer-editor-cap, 40dvh), var(${COMPOSER_EDITOR_AVAILABLE_HEIGHT_PROPERTY}, 100dvh))`,
        }}
      >
        <PromptMentionLinkContext.Provider value={resolveMentionLink ?? null}>
          <EditorContent
            editor={editor}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (editor === null || editor.isEditable) return;
              event.preventDefault();
              blurPromptEditor(editor);
            }}
            data-promptbox-editor-content=""
            data-promptbox-compact-content={isCompactLayout ? "" : undefined}
            className={cn(
              "h-full min-h-full",
              isCompactLayout && "flex items-center",
              "[&_.ProseMirror]:min-h-full [&_.ProseMirror]:leading-[1.7] [&_.ProseMirror]:outline-none",
              "[&_.ProseMirror_p]:m-0",
              "[&_.ProseMirror_blockquote]:my-1 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-surface-selected-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
              suggestionVisible
                ? // A suggestion shows at most two lines; Tab still accepts the full text.
                  // The hidden ::after reserves its height and overlaps the caret line.
                  "[&_.ProseMirror_p.is-editor-empty:first-child]:relative [&_.ProseMirror_p.is-editor-empty:first-child::before]:absolute [&_.ProseMirror_p.is-editor-empty:first-child::before]:inset-x-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:top-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:break-words [&_.ProseMirror_p.is-editor-empty:first-child::before]:line-clamp-2 [&_.ProseMirror_p.is-editor-empty:first-child::after]:line-clamp-2 [&_.ProseMirror_p.is-editor-empty:first-child::after]:[margin-top:-1lh] [&_.ProseMirror_p.is-editor-empty:first-child::after]:invisible [&_.ProseMirror_p.is-editor-empty:first-child::after]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::after]:break-words [&_.ProseMirror_p.is-editor-empty:first-child::after]:[content:attr(data-placeholder)]"
                : "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-subtle-foreground",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:font-light",
              "[&_.ProseMirror_p.is-editor-empty:first-child::before]:opacity-70",
            )}
          />
        </PromptMentionLinkContext.Provider>
      </div>
      {!isCompactLayout && moreLines > 0 && !expanded && (
        <div className="composer-editor-overflow" data-editor-overflow="">
          {!expanded && (
            <>
              <span className="composer-editor-fade" aria-hidden />
              <span>{moreLines} more lines · </span>
            </>
          )}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? "Collapse ⤡" : "Expand ⤢"}
          </button>
        </div>
      )}
    </>
  );
}
