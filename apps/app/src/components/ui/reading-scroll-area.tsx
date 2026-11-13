import * as React from "react";
import { ScrollArea } from "../../../../../packages/shared-ui/src/components/ui/scroll-area";

export const ReadingScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollArea>,
  React.ComponentPropsWithoutRef<typeof ScrollArea>
>((props, ref) => <ScrollArea {...props} ref={ref} overlay />);
