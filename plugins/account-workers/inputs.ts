import type { JsonValue } from "@get-bb/plugin-sdk/app";

export interface WorkerInputsValue {
  workspaceHostId: string;
  root: string;
}

export function readInputs(value: JsonValue | null): WorkerInputsValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { workspaceHostId, root } = value;
  return typeof workspaceHostId === "string" && typeof root === "string" ? { workspaceHostId, root } : null;
}
