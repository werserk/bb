import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRoot, confine, WorkspaceRefusal } from "./confine.js";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "aw-confine-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "src", "a.txt"), "a");
  await writeFile(path.join(outside, "secret"), "s");
});
afterEach(() => rm(base, { recursive: true, force: true }));

const refuses = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(WorkspaceRefusal);

describe("confine", () => {
  it("accepts relative and absolute paths inside the root, including new files", async () => {
    await expect(confine(root, "src/a.txt")).resolves.toBe(path.join(root, "src/a.txt"));
    await expect(confine(root, path.join(root, "src/a.txt"))).resolves.toBe(path.join(root, "src/a.txt"));
    await expect(confine(root, "new/dir/b.txt")).resolves.toBe(path.join(root, "new/dir/b.txt"));
    await expect(confine(root, ".")).resolves.toBe(root);
  });

  it("refuses .. escapes, absolute outside paths, sibling prefixes and NUL", async () => {
    await refuses(confine(root, "../outside/secret"));
    await refuses(confine(root, "src/../../outside/secret"));
    await refuses(confine(root, path.join(outside, "secret")));
    await refuses(confine(root, `${root}-evil/x`));
    await refuses(confine(root, "src/a\0.txt"));
  });

  it("refuses symlinked files and directories that leave the root", async () => {
    await symlink(path.join(outside, "secret"), path.join(root, "link-file"));
    await symlink(outside, path.join(root, "link-dir"));
    await refuses(confine(root, "link-file"));
    await refuses(confine(root, "link-dir/secret"));
    await refuses(confine(root, "link-dir/new-file"));
  });

  it("refuses a dangling symlink that a write would follow", async () => {
    await symlink(path.join(outside, "not-yet"), path.join(root, "dangling"));
    await refuses(confine(root, "dangling"));
  });

  it("allows symlinks that stay inside the root", async () => {
    await symlink(path.join(root, "src"), path.join(root, "alias"));
    await expect(confine(root, "alias/a.txt")).resolves.toBe(path.join(root, "alias/a.txt"));
  });
});

describe("checkRoot", () => {
  it("accepts the stored real root and refuses a root swapped for a symlink", async () => {
    await expect(checkRoot(root)).resolves.toBe(root);
    await rm(root, { recursive: true });
    await symlink("/", root);
    await refuses(checkRoot(root));
  });

  it("refuses a missing or relative root", async () => {
    await refuses(checkRoot(path.join(base, "gone")));
    await refuses(checkRoot("relative"));
  });
});
