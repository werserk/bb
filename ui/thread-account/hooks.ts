// Wires a thread's shared store to bb: the plugin's own RPC, the realtime
// channels and the connection state (a later `connected` = reconcile).
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_THREAD_ACCOUNT_CHANGED,
} from "../../src/realtime.js";
import type { threadAccountContract } from "../../src/thread-account.js";
import {
  getStore,
  retainStore,
  type ThreadAccountCaller,
  type ThreadAccountStore,
} from "./store.js";
import { threadAccountView, type ThreadAccountView } from "./view.js";

export interface UseThreadAccount {
  store: ThreadAccountStore;
  snapshot: ReturnType<ThreadAccountStore["getSnapshot"]>;
  view: ThreadAccountView;
}

export function useThreadAccount(threadId: string): UseThreadAccount {
  const rpc = useRpc<typeof threadAccountContract>();
  const call = useMemo<ThreadAccountCaller>(
    () => (method, input) =>
      (rpc.call as (method: string, input: unknown) => Promise<unknown>)(method, input),
    [rpc],
  );
  const store = useMemo(() => getStore(threadId, call), [threadId, call]);
  useEffect(() => retainStore(store), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useRealtime(ACCOUNT_POOL_THREAD_ACCOUNT_CHANGED, (payload: unknown) => store.onThreadChanged(payload));
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => store.onAccountsChanged());

  const connection = useRealtimeConnectionState();
  const wasDown = useRef(false);
  useEffect(() => {
    if (connection !== "connected") {
      wasDown.current = wasDown.current || connection === "reconnecting";
      return;
    }
    if (wasDown.current) {
      wasDown.current = false;
      store.onReconnect();
    }
  }, [connection, store]);

  const view = threadAccountView({
    get: snapshot.get,
    accounts: snapshot.accounts,
    error: snapshot.getError,
    dismissedId: snapshot.dismissedId,
    now: Date.now(),
  });
  return { store, snapshot, view };
}
