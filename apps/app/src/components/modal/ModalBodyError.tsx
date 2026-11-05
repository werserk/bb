import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

export function ModalBodyError({
  onRetry,
  onClose,
}: {
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="alert"
      data-bb-modal-error=""
      className="flex items-start gap-3 p-6"
    >
      <Icon
        name="AlertTriangle"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex flex-col items-start gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            This view could not load.
          </p>
          <p className="text-sm text-muted-foreground">
            Try again. If it keeps happening, close this and reload the plugin.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

export class ModalBodyBoundary extends Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[bb] modal body crashed", error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
