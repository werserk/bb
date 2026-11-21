import { expect, it, vi } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import { getPluginKvValue, setPluginKvValue, deleteAllPluginKvValues } from "../../src/data/plugin-storage.js";

it("reuses one KV statement across plugin/key bindings without caching values", () => {
  const db = createMigratedConnection();
  try {
    setPluginKvValue(db, "one", "a", "first");
    setPluginKvValue(db, "two", "a", "other");
    expect(getPluginKvValue(db, "one", "a")).toBe("first");
    const select = vi.spyOn(db, "select");
    try {
      expect(getPluginKvValue(db, "two", "a")).toBe("other");
      expect(getPluginKvValue(db, "one", "missing")).toBeUndefined();
      setPluginKvValue(db, "one", "a", "fresh");
      expect(getPluginKvValue(db, "one", "a")).toBe("fresh");
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
    deleteAllPluginKvValues(db, "one");
    expect(getPluginKvValue(db, "one", "a")).toBeUndefined();
    expect(getPluginKvValue(db, "two", "a")).toBe("other");
  } finally { db.$client.close(); }
});

it("keeps first-prepared reads valid after transaction rollback and binds literal keys", () => {
  const db = createMigratedConnection();
  try {
    const key = "' OR 1=1 --";
    setPluginKvValue(db, "p", key, "before");
    expect(() => db.transaction(() => {
      setPluginKvValue(db, "p", key, "during");
      expect(getPluginKvValue(db, "p", key)).toBe("during");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(getPluginKvValue(db, "p", key)).toBe("before");
    expect(getPluginKvValue(db, "p", "absent")).toBeUndefined();
  } finally { db.$client.close(); }
});
