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
      ...props
    },
    ref,
  ) => {
    const [dragging, setDragging] = React.useState(false);
    return (
      <ScrollAreaPrimitive.Root
        ref={ref}
        type="auto"
        data-overlay-scroll-area=""
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
          onPointerDownCapture={(event) => {
            if (event.button === 0) setDragging(true);
          }}
          onLostPointerCapture={() => setDragging(false)}
        />
        {horizontal ? (
          <ScrollBar
            orientation="horizontal"
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
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "bb-overlay-scrollbar flex touch-none select-none",
      orientation === "vertical" && "w-2 px-[2px]",
      orientation === "horizontal" && "h-2 flex-col py-[2px]",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="bb-overlay-scrollbar-thumb relative flex-1 rounded-full" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
