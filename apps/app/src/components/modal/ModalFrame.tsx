import type { ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";

interface ModalFrameProps {
  open: boolean;
  title: string | null;
  context: string | null;
  onClose: () => void;
  children: ReactNode;
}

export function ModalFrame({
  open,
  title,
  context,
  onClose,
  children,
}: ModalFrameProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent hideCloseButton data-bb-modal="">
        {title === null ? null : (
          <>
            <div className="flex items-center gap-2">
              {context === null ? null : (
                <span className="text-muted-foreground">{context} /</span>
              )}
              <DialogTitle className="min-w-0 flex-1 truncate">
                {title}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={onClose}
              >
                <Icon name="X" />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto">{children}</div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
