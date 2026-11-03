import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";
import { waitForNavigationSettled } from "@/lib/navigation-window";

export type AppFetchPriority = "high" | "low";

const priorityBySignal = new WeakMap<AbortSignal, AppFetchPriority>();

export function withFetchPriority(
  signal: AbortSignal,
  priority: AppFetchPriority,
): AbortSignal {
  priorityBySignal.set(signal, priority);
  return signal;
}

function requestPriority(init?: RequestInit): AppFetchPriority | undefined {
  if (init?.priority === "high" || init?.priority === "low") {
    return init.priority;
  }
  return init?.signal ? priorityBySignal.get(init.signal) : undefined;
}

const APP_SURFACE_MOBILE: RequestAppSurface = "mobile";

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.bbDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }
  if (isInsideNativeShell()) {
    return APP_SURFACE_MOBILE;
  }
  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());
  return {
    ...init,
    cache: init?.cache ?? "no-store",
    headers,
  };
}

export async function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const priority = requestPriority(init);
  if (priority === "low") {
    await waitForNavigationSettled();
  }
  return fetch(
    input,
    appSurfaceRequestInit(
      priority === undefined ? init : { ...init, priority },
    ),
  );
}
