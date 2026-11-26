import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceRefusal } from "../confine.js";

export interface ProfileFile {
  path: string;
  content: string;
  mode?: number;
}

export async function writeProfileFiles(dir: string, files: readonly ProfileFile[]): Promise<void> {
  for (const file of files) {
    const target = path.resolve(dir, file.path);
    if (path.isAbsolute(file.path) || !target.startsWith(dir + path.sep)) {
      throw new WorkspaceRefusal(`profile file ${file.path} is outside the scratch directory`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    if (file.mode !== undefined) await chmod(target, file.mode);
  }
}
