import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@bb/shared-ui/icon";
import { ShortcutPill } from "@bb/shared-ui/shortcut-pill";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { getModalOpener } from "@/lib/modal-host";

const DESKTOP_AUTOFOCUS_SELECTOR =
  "[data-autofocus], input:not([type=hidden]), textarea, select";
const COMPACT_AUTOFOCUS_SELECTOR = "[data-autofocus]";

const SCRIM_CLASS = "bg-[var(--surface-scrim,rgb(0_0_0/0.4))]";
const PANEL_CLASS =
  "h-[min(740px,calc(100dvh-48px))] w-[min(1040px,calc(100vw-48px))] max-w-none grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden rounded-lg p-0 shadow-[var(--shadow-lift,0_8px_32px_rgb(0_0_0/0.4))]";
const SHEET_CLASS =
  "min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0";
const SHEET_PANEL_CLASS =
  "h-[calc(100dvh-44px)] max-h-[calc(100dvh-44px-var(--bb-drawer-keyboard-inset,0px))]";

interface ModalPanelProps {
  compact: boolean;
  title: string;
  context: string | null;
  onClose: () => void;
  children: ReactNode;
}

function ModalPanel({
  compact,
  title,
  context,
  onClose,
  children,
}: ModalPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const finePointer = !usePointerCoarse();

  useEffect(() => {
    const field = bodyRef.current?.querySelector<HTMLElement>(
      compact ? COMPACT_AUTOFOCUS_SELECTOR : DESKTOP_AUTOFOCUS_SELECTOR,
    );
    (field ?? panelRef.current)?.focus({ preventScroll: true });
  }, [compact]);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-bb-modal-panel=""
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {compact ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="ChevronLeft" />
          </Button>
        ) : null}
        <DialogTitle className="min-w-0 flex-1 truncate">
          {context === null ? null : (
            <>
              <span className="font-normal text-muted-foreground">
                {context} /
              </span>{" "}
            </>
          )}
          {title}
        </DialogTitle>
        {compact ? null : (
          <>
            {finePointer ? (
              <ShortcutPill
                shortcut={{ label: "Esc" }}
                className="bg-muted font-mono text-2xs opacity-100"
              />
            ) : null}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close"
                    onClick={onClose}
                  >
                    <Icon name="X" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}
      </div>
      <div
        ref={bodyRef}
        data-bb-modal-body=""
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {children}
      </div>
    </div>
  );
}

interface ModalFrameProps {
  open: boolean;
  title: string | null;
  context: string | null;
  token: string | null;
  onClose: () => void;
  children: ReactNode;
}

export function ModalFrame({
  open,
  title,
  context,
  token,
  onClose,
  children,
}: ModalFrameProps) {
  const compact = useIsCompactViewport();
  const lastToken = useRef<string | null>(null);
  const openRef = useRef(open);

  useEffect(() => {
    if (token !== null) lastToken.current = token;
  }, [token]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const restoreOpener = (event?: Event) => {
    if (openRef.current) return;
    const opener =
      lastToken.current === null ? null : getModalOpener(lastToken.current);
    if (opener === null || !opener.isConnected) return;
    event?.preventDefault();
    opener.focus({ preventScroll: true });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        hideCloseButton
        data-bb-modal=""
        aria-describedby={undefined}
        overlayClassName={SCRIM_CLASS}
        className={compact ? SHEET_CLASS : PANEL_CLASS}
        compactContentClassName={SHEET_PANEL_CLASS}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={restoreOpener}
        onAfterCloseAutoFocus={() => restoreOpener()}
      >
        {title === null ? null : (
          <ModalPanel
            compact={compact}
            title={title}
            context={context}
            onClose={onClose}
          >
            {children}
          </ModalPanel>
        )}
      </DialogContent>
    </Dialog>
  );
}
