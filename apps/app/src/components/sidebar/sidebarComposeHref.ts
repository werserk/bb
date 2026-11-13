import { getRootComposeRoutePath } from "@/lib/route-paths";

export function buildSidebarComposeHref(
  projectId: string,
  environmentId: string | null,
): string {
  const search = new URLSearchParams({ projectId });
  if (environmentId !== null) search.set("reuseEnvironmentId", environmentId);
  return `${getRootComposeRoutePath()}?${search}`;
}

export function readSidebarComposeTarget(search: string) {
  const params = new URLSearchParams(search);
  const projectId = params.get("projectId");
  if (!projectId) return null;
  return {
    projectId,
    reuseEnvironmentId: params.get("reuseEnvironmentId") || null,
  };
}
