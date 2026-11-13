import { createContext, useContext } from "react";

export const CoreModalTokenContext = createContext<string | null>(null);

export function useCoreModalToken(): string | null {
  return useContext(CoreModalTokenContext);
}
