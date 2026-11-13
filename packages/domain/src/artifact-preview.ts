function isPathString(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.trim() !== value ||
    /[\u0000-\u001f]/u.test(value)
  )
    return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export function isArtifactCanonicalRoot(value: unknown): value is string {
  return (
    isPathString(value) &&
    (/^\/(?!\/)/u.test(value) ||
      /^[a-z]:[\\/]/iu.test(value) ||
      /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)) &&
    !value
      .split(/[\\/]/u)
      .some((segment) => segment === "." || segment === "..")
  );
}

export function isArtifactRelativePath(value: unknown): value is string {
  return (
    isPathString(value) &&
    !value.includes("\\") &&
    !/^[a-z]:/iu.test(value) &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function artifactPreviewCsp(absoluteLeaseBase: string): string {
  const base = new URL(absoluteLeaseBase);
  if (
    !/^https?:$/u.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith("/") ||
    /[\s;'"<>]/u.test(base.href)
  )
    throw new Error("Invalid artifact lease base");
  const source = base.origin + base.pathname;
  return `default-src 'none'; frame-src 'none'; img-src data: ${source}; style-src 'unsafe-inline' ${source}; script-src 'unsafe-inline' ${source}; form-action 'none'`;
}
