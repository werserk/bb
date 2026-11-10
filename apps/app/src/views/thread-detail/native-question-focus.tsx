import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ThreadPlanFocusRequest } from "./thread-plan-focus";

const NativeQuestionFocusContext = createContext<{
  request: ThreadPlanFocusRequest | undefined;
  reveal(request: ThreadPlanFocusRequest): void;
} | null>(null);

export function NativeQuestionFocusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [request, reveal] = useState<ThreadPlanFocusRequest>();
  const value = useMemo(() => ({ request, reveal }), [request]);
  return (
    <NativeQuestionFocusContext.Provider value={value}>
      {children}
    </NativeQuestionFocusContext.Provider>
  );
}

export function useNativeQuestionFocus() {
  return useContext(NativeQuestionFocusContext);
}
