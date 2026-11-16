import { timingSafeEqual } from "node:crypto";

export function validPluginToken(
  headers: Headers,
  queryTokens: string[],
  expected: string | undefined,
): boolean {
  if (!expected || queryTokens.length > 1) return false;
  const authorization = headers.get("authorization");
  const bearer =
    authorization === null
      ? null
      : /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(authorization)?.[1];
  if (authorization !== null && !bearer) return false;
  const values = [
    headers.get("x-bb-plugin-token"),
    bearer,
    ...queryTokens,
  ].filter((value): value is string => value !== null && value !== undefined);
  if (values.length === 0) return false;
  const target = Buffer.from(expected);
  return values.every((value) => {
    const candidate = Buffer.from(value);
    return (
      candidate.length === target.length && timingSafeEqual(candidate, target)
    );
  });
}
