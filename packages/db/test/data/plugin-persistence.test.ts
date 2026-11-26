import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginArtifact,
  deletePluginArtifact,
  deleteInstalledPlugin,
  getInstalledPluginRegistration,
  getInstalledPlugin,
  listPluginArtifacts,
  listPluginArtifactsAtOrUnderPath,
  listPluginArtifactsUnderPath,
  listPluginKvKeys,
  setPluginKvValue,
  upsertInstalledPlugin,
  type DbConnection,
} from "../../src/index.js";
import type { UpsertInstalledPluginInput } from "../../src/data/plugins.js";
import { createMigratedConnection } from "../../src/testing.js";

describe("normalized plugin persistence", () => {
  let db: DbConnection;

  beforeEach(() => {
    db = createMigratedConnection();
  });

  afterEach(() => db.$client.close());

  it("persists typed plugin intent and an active artifact reference", () => {
    const linearPlugin: UpsertInstalledPluginInput = {
      id: "linear",
      source: "npm:bb-plugin-linear@1.2.3",
      provenance: {
        kind: "catalog",
        marketplace: "bb-community",
        entryId: "linear",
      },
      sourceIntent: {
        kind: "npm",
        packageName: "bb-plugin-linear",
        registry: "https://registry.npmjs.org",
        requestedSpec: "^1.2.0",
        specKind: "range",
      },
      exactResolution: {
        kind: "npm",
        version: "1.2.3",
        integrity: "sha512-example",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: "2.0.0",
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/plugins/linear",
      version: "1.2.3",
      enabled: true,
      enabledFollowsDefault: false,
    };
    upsertInstalledPlugin(db, linearPlugin);
    createPluginArtifact(db, {
      id: "artifact-1",
      pluginId: "linear",
      sourceKind: "npm",
      npmResolvedVersion: "1.2.3",
      gitResolvedCommit: null,
      gitCheckoutRoot: null,
      path: "/cache/artifact-1.tgz",
      integrity: "sha512-example",
      contentHash: "sha256-example",
      validationResult: "valid",
      validatedAt: 100,
    });
    upsertInstalledPlugin(db, { ...linearPlugin, activeArtifactId: "artifact-1" });
    expect(getInstalledPlugin(db, "linear")?.rootDir).toBe(
      "/cache/artifact-1.tgz",
    );

    expect(getInstalledPluginRegistration(db, "linear")).toMatchObject({
      provenance: "catalog",
      catalogEntryId: "linear",
      catalogMarketplaceName: "bb-community",
      sourceKind: "npm",
      sourceNpmRequestedSpec: "^1.2.0",
      sourceNpmSpecKind: "range",
      npmResolvedVersion: "1.2.3",
      activeArtifactId: "artifact-1",
    });
    expect(listPluginArtifacts(db, "linear")).toHaveLength(1);
    expect(deletePluginArtifact(db, "artifact-1")).toBe(true);
    expect(getInstalledPluginRegistration(db, "linear")?.activeArtifactId).toBe(
      null,
    );
  });

  it("rejects an npm artifact without registry integrity at runtime", () => {
    const invalidArtifact = {
      id: "artifact-invalid",
      pluginId: "missing",
      sourceKind: "npm",
      npmResolvedVersion: "1.2.3",
      gitResolvedCommit: null,
      path: "/cache/artifact-invalid.tgz",
      integrity: null,
      contentHash: null,
      validationResult: "pending",
      validatedAt: null,
    };
    expect(() =>
      Reflect.apply(createPluginArtifact, undefined, [db, invalidArtifact]),
    ).toThrow(/resolution fields/);
  });

  it("stores a git ref and a git tag range in mutually exclusive columns", () => {
    const common = {
      provenance: { kind: "direct" } as const,
      exactResolution: { kind: "git" as const, commit: "abcdef1234567" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/cache/repo/abcdef1234567",
      version: "1.4.2",
      enabled: true,
      enabledFollowsDefault: false,
    };
    upsertInstalledPlugin(db, {
      ...common,
      id: "ranged",
      source: "git:/repo@semver:notes/:^1.0.0",
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: "plugins/notes",
        selector: {
          kind: "range",
          range: "^1.0.0",
          tagPrefix: "notes/",
          resolvedTag: "notes/v1.4.2",
        },
      },
    });
    expect(getInstalledPlugin(db, "ranged")).toMatchObject({
      sourceGitRange: "^1.0.0",
      sourceGitTagPrefix: "notes/",
      sourceGitResolvedTag: "notes/v1.4.2",
      sourceGitRequestedRef: null,
      sourceGitRefKind: null,
    });

    upsertInstalledPlugin(db, {
      ...common,
      id: "ranged",
      source: "git:/repo@main",
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: "plugins/notes",
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
    });
    expect(getInstalledPlugin(db, "ranged")).toMatchObject({
      sourceGitRange: null,
      sourceGitTagPrefix: null,
      sourceGitResolvedTag: null,
      sourceGitRequestedRef: "main",
      sourceGitRefKind: "branch",
    });
  });

  it("retains artifact records when a plugin registration is removed", () => {
    const retainedPlugin: UpsertInstalledPluginInput = {
      id: "retained",
      source: "git:/repo@main",
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: "/repo",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit: "abcdef1234567" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/cache/repo/abcdef1234567",
      version: "1.0.0",
      enabled: true,
      enabledFollowsDefault: false,
    };
    upsertInstalledPlugin(db, retainedPlugin);
    createPluginArtifact(db, {
      id: "retained-artifact",
      pluginId: "retained",
      sourceKind: "git",
      npmResolvedVersion: null,
      gitResolvedCommit: "abcdef1234567",
      gitCheckoutRoot: "/cache/repo/abcdef1234567",
      path: "/cache/repo/abcdef1234567",
      integrity: null,
      contentHash: "sha256:retained",
      validationResult: "valid",
      validatedAt: Date.now(),
    });
    upsertInstalledPlugin(db, { ...retainedPlugin, activeArtifactId: "retained-artifact" });

    expect(deleteInstalledPlugin(db, "retained")).toBe(true);
    expect(listPluginArtifacts(db, "retained")).toHaveLength(1);
  });

  describe("plugin KV prefix list", () => {
    function store(pluginId: string, keys: readonly string[]): void {
      for (const key of keys) setPluginKvValue(db, pluginId, key, "value");
    }

    it("Non-ASCII prefix", () => {
      store("kv-plugin", [
        "проект/1",
        "проектб/2",
        "проеку/x",
        "😀/3",
        "😁/4",
      ]);

      expect(listPluginKvKeys(db, "kv-plugin", "проект")).toEqual([
        "проект/1",
        "проектб/2",
      ]);
      expect(listPluginKvKeys(db, "kv-plugin", "😀")).toEqual(["😀/3"]);
    });

    it("Case-sensitive prefix", () => {
      store("kv-plugin", ["Abc/1", "abc/2", "ABC/3"]);

      expect(listPluginKvKeys(db, "kv-plugin", "abc")).toEqual(["abc/2"]);
      expect(listPluginKvKeys(db, "kv-plugin", "Abc")).toEqual(["Abc/1"]);
    });

    it("Empty prefix", () => {
      store("kv-plugin", ["b", "a/1", "\u{10ffff}"]);
      store("other-plugin", ["a/2"]);

      expect(listPluginKvKeys(db, "kv-plugin", "")).toEqual([
        "a/1",
        "b",
        "\u{10ffff}",
      ]);
      expect(listPluginKvKeys(db, "kv-plugin")).toEqual([
        "a/1",
        "b",
        "\u{10ffff}",
      ]);
    });

    it("Lone surrogate in a key", () => {
      store("kv-plugin", [
        "x\ud800/1",
        "x\u{fffd}/2",
        "x\ud801/3",
        "x\u{d7ff}/4",
        "y/5",
      ]);
      const replaced = "x\u{fffd}\u{fffd}\u{fffd}";

      expect(listPluginKvKeys(db, "kv-plugin", "x\ud800")).toEqual([
        `${replaced}/1`,
      ]);
      expect(listPluginKvKeys(db, "kv-plugin", "x\u{d7ff}")).toEqual([
        "x\u{d7ff}/4",
      ]);
      expect(listPluginKvKeys(db, "kv-plugin", "x")).toEqual([
        "x\u{d7ff}/4",
        `${replaced}/1`,
        `${replaced}/3`,
        "x\u{fffd}/2",
      ]);
    });

    it("does not match a lone high surrogate against an astral character", () => {
      store("kv-plugin", [
        "x\ud83d/1",
        "x\u{1f600}/2",
        "x\ud800\udbff/3",
        "x\ud800\u{e000}/4",
      ]);

      expect(listPluginKvKeys(db, "kv-plugin", "x\ud83d")).toHaveLength(1);
      expect(
        listPluginKvKeys(db, "kv-plugin", "x\ud800\udbff"),
      ).toHaveLength(1);
    });

    it("Code-point order", () => {
      store("kv-plugin", ["p/\u{1f600}", "p/\u{e000}", "p/\u{ffff}", "p/z"]);

      expect(listPluginKvKeys(db, "kv-plugin", "p/")).toEqual([
        "p/z",
        "p/\u{e000}",
        "p/\u{ffff}",
        "p/\u{1f600}",
      ]);
    });

    it("keeps keys that continue with U+10FFFF and stops at the successor", () => {
      store("kv-plugin", ["a", "a\u{10ffff}", "a\u{10ffff}z", "b", "ab"]);

      expect(listPluginKvKeys(db, "kv-plugin", "a")).toEqual([
        "a",
        "ab",
        "a\u{10ffff}",
        "a\u{10ffff}z",
      ]);
      expect(listPluginKvKeys(db, "kv-plugin", "\u{10ffff}")).toEqual([]);
    });

    it("Index range", () => {
      store("kv-plugin", ["abc/1"]);
      const sources: string[] = [];
      const prepare = db.$client.prepare.bind(db.$client);
      const spy = vi
        .spyOn(db.$client, "prepare")
        .mockImplementation((source: string) => {
          sources.push(source);
          return prepare(source);
        });
      try {
        expect(listPluginKvKeys(db, "kv-plugin", "abc")).toEqual(["abc/1"]);
      } finally {
        spy.mockRestore();
      }

      expect(sources).toHaveLength(1);
      const plan = db.$client
        .prepare(`EXPLAIN QUERY PLAN ${sources[0]}`)
        .all("kv-plugin", "abc", "abd") as { detail: string }[];
      expect(plan.map((row) => row.detail)).toEqual([
        expect.stringMatching(
          /^SEARCH plugin_kv USING .*\(plugin_id=\? AND key>\? AND key<\?\)$/u,
        ),
      ]);
    });
  });

  it("matches LIKE metacharacters in key and path prefixes literally", () => {
    for (const key of ["a_b/1", "axb/2", "50%/3", "50x/4", "c\\d/5", "cxd/6"]) {
      setPluginKvValue(db, "kv-plugin", key, "value");
    }
    expect(listPluginKvKeys(db, "kv-plugin", "a_b")).toEqual(["a_b/1"]);
    expect(listPluginKvKeys(db, "kv-plugin", "50%")).toEqual(["50%/3"]);
    expect(listPluginKvKeys(db, "kv-plugin", "c\\")).toEqual(["c\\d/5"]);

    for (const [id, path] of [
      ["root", "/cache/a_b"],
      ["child", "/cache/a_b/child"],
      ["sibling", "/cache/axb/child"],
    ] as const) {
      createPluginArtifact(db, {
        id,
        pluginId: "path-plugin",
        sourceKind: "npm",
        npmResolvedVersion: "1.0.0",
        gitResolvedCommit: null,
        gitCheckoutRoot: null,
        path,
        integrity: "sha512-example",
        contentHash: null,
        validationResult: "valid",
        validatedAt: 100,
      });
    }
    expect(
      listPluginArtifactsUnderPath(db, "/cache/a_b", "/").map(({ id }) => id),
    ).toEqual(["child"]);
    expect(
      listPluginArtifactsAtOrUnderPath(db, "/cache/a_b", "/").map(
        ({ id }) => id,
      ),
    ).toEqual(["root", "child"]);
  });
});
