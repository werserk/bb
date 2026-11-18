import type { NotificationHub } from "../../ws/hub.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function configChanged(before: unknown, after: unknown): boolean {
  return JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after));
}

export function notifyConfigChangedIfChanged(
  hub: Pick<NotificationHub, "notifySystem">,
  changed: boolean,
): boolean {
  if (changed) hub.notifySystem(["config-changed"]);
  return changed;
}
