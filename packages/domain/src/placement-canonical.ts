import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { jsonValueSchema, type JsonValue } from "./json-value.js";

function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
export function canonicalJsonBytes(input: unknown): string {
  return JSON.stringify(sorted(jsonValueSchema.parse(input)));
}
export function sha256Digest(bytes: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(bytes)))}`;
}
export function canonicalPlacementPayload(input: {
  schemaVersion: 1;
  intent: JsonValue;
}): string {
  return canonicalJsonBytes({
    schemaVersion: input.schemaVersion,
    intent: input.intent,
  });
}
