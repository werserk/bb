import { createContext, type ReactNode } from "react";

export const PendingSendPresentationContext = createContext<
  ((rowId: string) => ReactNode) | null
>(null);
