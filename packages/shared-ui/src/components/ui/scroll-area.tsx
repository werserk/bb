import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "../../lib/utils";

type ScrollAreaProps = React.ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.Root
> & {
  viewportRef?: React.Ref<
    React.ElementRef<typeof ScrollAreaPrimitive.Viewport>
  >;
  viewportProps?: Omit<
    React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>,
    "children"
  > & {
    [attribute: `data-${string}`]: string | number | boolean | undefined;
  };
  scrollbarClassName?: string;
  horizontal?: boolean;
  overlay?: boolean;
};

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(
  (
    {
      className,
      children,
      viewportRef,
      viewportProps,
      scrollbarClassName,
      horizontal = false,
      overlay = false,
      ...props
    },
    ref,
  ) => {
    const [dragging, setDragging] = React.useState(false);
    return (
      <ScrollAreaPrimitive.Root
        ref={ref}
        type={overlay ? "auto" : undefined}
        data-overlay-scroll-area={overlay ? "" : undefined}
        data-dragging={dragging || undefined}
        className={cn("relative overflow-hidden", className)}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          ref={viewportRef}
          {...viewportProps}
          className={cn(
            "h-full w-full rounded-[inherit]",
            viewportProps?.className,
          )}
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar
          className={scrollbarClassName}
          overlay={overlay}
          onPointerDownCapture={(event) => {
            if (event.button === 0) setDragging(true);
          }}
          onLostPointerCapture={() => setDragging(false)}
        />
        {horizontal ? (
          <ScrollBar
            orientation="horizontal"
            overlay={overlay}
            onPointerDownCapture={(event) => {
              if (event.button === 0) setDragging(true);
            }}
            onLostPointerCapture={() => setDragging(false)}
          />
        ) : null}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  },
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<
    typeof ScrollAreaPrimitive.ScrollAreaScrollbar
  > & { overlay?: boolean }
>(({ className, orientation = "vertical", overlay = false, ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none",
      overlay ? "bb-overlay-scrollbar" : "transition-colors",
      orientation === "vertical" &&
        (overlay
          ? "w-2 px-[2px]"
          : "h-full w-2.5 border-l border-l-transparent p-[1px]"),
      orientation === "horizontal" &&
        (overlay
          ? "h-2 flex-col py-[2px]"
          : "h-2.5 flex-col border-t border-t-transparent p-[1px]"),
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      className={cn(
        "relative flex-1 rounded-full",
        overlay ? "bb-overlay-scrollbar-thumb" : "bg-border",
      )}
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
