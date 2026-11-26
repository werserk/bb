import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class WorkspaceRefusal extends Error {
  override name = "WorkspaceRefusal";
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export async function checkRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) throw new WorkspaceRefusal("root is not absolute");
  let real: string;
  try {
    real = await realpath(root);
  } catch {
    throw new WorkspaceRefusal(`workspace root ${root} no longer exists`);
  }
  if (real !== root) {
    throw new WorkspaceRefusal(
      `workspace root ${root} now resolves to ${real}; rebind the workspace`,
    );
  }
  return real;
}

export async function confine(root: string, input: string): Promise<string> {
  if (input.includes("\0")) throw new WorkspaceRefusal("path contains NUL");
  const lexical = path.resolve(root, input);
  if (!isInside(root, lexical)) {
    throw new WorkspaceRefusal(
      `${input} is outside the workspace root ${root}`,
    );
  }
  let probe = lexical;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isInside(root, real)) {
        throw new WorkspaceRefusal(
          `${input} resolves outside the workspace root ${root}`,
        );
      }
      return lexical;
    } catch (error) {
      if (error instanceof WorkspaceRefusal) throw error;
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
        throw error;
      }
      if (await lstat(probe).then(() => true, () => false)) {
        throw new WorkspaceRefusal(`${input} goes through a dangling symlink`);
      }
      const parent = path.dirname(probe);
      if (parent === probe) return lexical;
      probe = parent;
    }
  }
}

export function display(root: string, absolute: string): string {
  return path.relative(root, absolute) || ".";
}
