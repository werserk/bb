import { createContext } from "react";

export const FilePreviewScrollPositionContext = createContext<{
  scrollTop: number;
} | null>(null);

export const FilePreviewHostScrollContext = createContext(false);
