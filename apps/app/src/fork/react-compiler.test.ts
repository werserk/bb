import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { cachedReactCompiler } from "../../vite-react-compiler.js";

const fork = fileURLToPath(new URL("./", import.meta.url));
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));

afterEach(() => vi.unstubAllEnvs());

it("compiles every fork source with the production React Compiler settings", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const entries = (await readdir(fork, { recursive: true }))
    .filter(
      (file) => /\.tsx?$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file),
    )
    .map((file) => resolve(fork, file));
  expect(entries.length).toBeGreaterThan(0);
  const temporary = resolve(workspace, ".tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(resolve(temporary, "fork-react-compiler-"));
  try {
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [react(), await cachedReactCompiler(resolve(root, "cache"))],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: entries,
          external: (id, importer) =>
            importer !== undefined && !id.startsWith("./"),
          preserveEntrySignatures: "strict",
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
