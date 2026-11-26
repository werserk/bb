// Token helpers for the hub's own logins. Accounts are added only by the hub's
// login flows (Claude OAuth, Codex device code) or as API keys. Nothing here
// reads a CLI's login (~/.claude, ~/.codex or a keychain): a copied login gives
// one account two refresh owners, and refresh-token rotation then forces
// re-logins.
import type { JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jwtPayloadSchema = z.record(z.string(), jsonValueSchema);
type JwtPayload = z.infer<typeof jwtPayloadSchema>;
export const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
export const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";

function jwtPayload(token: string): JwtPayload | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed = jwtPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function codexAccessTokenExpiresAt(token: string): number | null {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number"
    ? Math.round(payload.exp * 1_000)
    : null;
}
