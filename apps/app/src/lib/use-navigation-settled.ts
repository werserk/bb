import { useSyncExternalStore } from "react";
import {
  isNavigationWindowOpen,
  subscribeNavigationWindow,
} from "./navigation-window";

function readSettled(): boolean {
  return !isNavigationWindowOpen();
}

export function useNavigationSettled(): boolean {
  return useSyncExternalStore(
    subscribeNavigationWindow,
    readSettled,
    () => true,
  );
}
