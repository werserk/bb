import * as workerThreads from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { PendingSendJournal } from "../src/pending-send-journal.js";

it("Hide aborts a permanently blocked reload and a late lock grant cannot hydrate", async () => {
  let callback: ((lock: object | null) => Promise<void>) | undefined;
  let signal: AbortSignal | undefined;
  const storage = new Map<string, string>([
    [
      "account",
      JSON.stringify({
        version: 1,
        journalId: "old",
        entries: [{ id: "inherited" }],
      }),
    ],
  ]);
  const journal = new PendingSendJournal({
    key: "account",
    reload: true,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    locks: {
      request: async (_name, options, cb) => {
        signal = options.signal;
        callback = cb;
      },
    },
  });
  let hydrated = 0;
  journal.start(() => {
    hydrated++;
  });
  expect(journal.status).toBe("waiting");
  const original = storage.get("account");
  journal.hide();
  expect(signal?.aborted).toBe(true);
  await callback?.({});
  expect(hydrated).toBe(0);
  expect(storage.get("account")).toBe(original);
  expect(journal.status).toBe("hidden");
});
it("Refresh cancels only its wait and does not force a lock takeover", async () => {
  const requests: {
    signal: AbortSignal | undefined;
    callback: (lock: object | null) => Promise<void>;
  }[] = [];
  let writes = 0,
    hydrates = 0;
  const journal = new PendingSendJournal({
    key: "account",
    reload: true,
    storage: {
      getItem: () =>
        JSON.stringify({ version: 1, journalId: "old", entries: [] }),
      setItem: () => {
        writes++;
      },
      removeItem: () => {
        writes++;
      },
    },
    locks: {
      request: async (_name, options, callback) => {
        requests.push({ signal: options.signal, callback });
      },
    },
  });
  journal.start(() => {
    hydrates++;
  });
  journal.refresh();
  expect(requests).toHaveLength(2);
  expect(requests[0]?.signal?.aborted).toBe(true);
  expect(requests[1]?.signal?.aborted).toBe(false);
  await requests[0]?.callback({});
  expect(hydrates).toBe(0);
  expect(writes).toBe(0);
  expect(journal.status).toBe("waiting");
  journal.dispose();
});

const nativeLocks =
  "locks" in workerThreads ? (workerThreads.locks as LockManager) : undefined;

it.skipIf(!nativeLocks)(
  "cancels a blocked native reload acquisition without taking over its predecessor",
  async () => {
    const key = `journal-test/${crypto.randomUUID()}`;
    const journalId = crypto.randomUUID();
    const lockName = `bb-pending-send/${key}/${journalId}`;
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const predecessor = nativeLocks!.request(lockName, async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const hydrate = vi.fn();
    const journal = new PendingSendJournal({
      key,
      reload: true,
      storage: {
        getItem: () => JSON.stringify({ version: 1, journalId, entries: [] }),
        setItem: () => {
          throw Error("must not write before ownership");
        },
        removeItem: () => {},
      },
      locks: nativeLocks,
    });
    try {
      journal.start(hydrate);
      await vi.waitFor(async () => {
        expect((await nativeLocks!.query()).pending).toContainEqual(
          expect.objectContaining({ name: lockName }),
        );
      });
      journal.hide();
      expect(journal.status).toBe("hidden");
      expect(hydrate).not.toHaveBeenCalled();
      expect((await nativeLocks!.query()).held).toContainEqual(
        expect.objectContaining({ name: lockName }),
      );
      release();
      await predecessor;
      await nativeLocks!.request(lockName, async () => {});
      expect(hydrate).not.toHaveBeenCalled();
      expect(journal.status).toBe("hidden");
    } finally {
      journal.dispose();
      release();
      await predecessor;
    }
  },
);

it("uses valid non-waiting lock options and ignores a late grant after Hide", async () => {
  const key = `journal-test/${crypto.randomUUID()}`;
  const journalId = crypto.randomUUID();
  const hydrate = vi.fn();
  let grant!: (lock: object | null) => Promise<void>;
  const journal = new PendingSendJournal({
    key,
    reload: false,
    storage: {
      getItem: () => JSON.stringify({ version: 1, journalId, entries: [] }),
      setItem: () => {
        throw Error("must not write after Hide");
      },
      removeItem: () => {},
    },
    locks: {
      request: async (_name, options, callback) => {
        if (options.ifAvailable && options.signal)
          throw new DOMException(
            "signal cannot be used with steal or ifAvailable",
            "NotSupportedError",
          );
        grant = callback;
      },
    },
  });
  journal.start(hydrate);
  expect(grant).toBeTypeOf("function");
  journal.hide();
  await grant({});
  expect(hydrate).not.toHaveBeenCalled();
  expect(journal.status).toBe("hidden");
  journal.dispose();
});
it("unavailable locking leaves memory sending available without reading storage", () => {
  let reads = 0;
  const journal = new PendingSendJournal({
    key: "account",
    reload: false,
    storage: {
      getItem: () => {
        reads++;
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    },
  });
  journal.start(() => {
    throw Error("must not hydrate");
  });
  expect(journal.status).toBe("unavailable");
  expect(reads).toBe(0);
});
it("hydrates only on actual grant, then saves once without recursive notifications", async () => {
  let grant!: (lock: object | null) => Promise<void>;
  let notifications = 0;
  let hydrated = 0;
  let writes = 0;
  const journal = new PendingSendJournal({
    key: "account",
    reload: true,
    storage: {
      getItem: () =>
        JSON.stringify({
          version: 1,
          journalId: "old",
          entries: [{ id: "pending" }],
        }),
      setItem: () => {
        writes++;
      },
      removeItem: () => {},
    },
    locks: {
      request: async (_name, _options, callback) => {
        grant = callback;
      },
    },
    onChange: () => {
      notifications++;
      if (journal.status === "owned") journal.save([]);
    },
  });
  journal.start((entries) => {
    hydrated = entries.length;
  });
  expect(hydrated).toBe(0);
  const held = grant({});
  await Promise.resolve();
  expect(hydrated).toBe(1);
  expect(writes).toBe(1);
  expect(notifications).toBe(2);
  journal.dispose();
  await held;
});
it("a duplicated navigation starts a fresh namespace instead of waiting", async () => {
  const storage = new Map<string, string>([
    [
      "account",
      JSON.stringify({
        version: 1,
        journalId: "inherited",
        entries: ["private pending"],
      }),
    ],
  ]);
  const names: string[] = [];
  const waits: boolean[] = [];
  let hydrated: unknown[] = [];
  let held: Promise<void> | undefined;
  const journal = new PendingSendJournal({
    key: "account",
    reload: false,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    locks: {
      request: async (name, options, callback) => {
        names.push(name);
        waits.push(options.ifAvailable !== true);
        if (names.length === 1) await callback(null);
        else held = callback({});
      },
    },
  });
  journal.start((entries) => {
    hydrated = entries;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(names).toHaveLength(2);
  expect(names[0]).not.toBe(names[1]);
  expect(waits).toEqual([false, false]);
  expect(hydrated).toEqual([]);
  expect(JSON.parse(storage.get("account")!)).toMatchObject({
    journalId: "inherited",
    entries: ["private pending"],
  });
  journal.save(["own"]);
  const saved = JSON.parse(storage.get("account")!);
  expect(saved.journalId).not.toBe("inherited");
  expect(saved.entries).toEqual(["own"]);
  journal.dispose();
  await held;
});
it("hydrates the journal at actual grant after its predecessor finishes writing", async () => {
  let grant!: (lock: object | null) => Promise<void>;
  let value = JSON.stringify({
    version: 1,
    journalId: "old",
    entries: ["before"],
  });
  let hydrated: unknown[] = [];
  const journal = new PendingSendJournal({
    key: "account",
    reload: true,
    storage: {
      getItem: () => value,
      setItem: (_key, next) => {
        value = next;
      },
      removeItem: () => {},
    },
    locks: {
      request: async (_name, _options, callback) => {
        grant = callback;
      },
    },
  });
  journal.start((entries) => {
    hydrated = entries;
  });
  value = JSON.stringify({ version: 1, journalId: "old", entries: ["after"] });
  const held = grant({});
  await Promise.resolve();
  expect(hydrated).toEqual(["after"]);
  journal.dispose();
  await held;
});
it("keeps ownership after quota failure and rejects an unknown journal version", async () => {
  let grant!: (lock: object | null) => Promise<void>;
  let value: string | null = null;
  const journal = new PendingSendJournal({
    key: "account",
    reload: false,
    storage: {
      getItem: () => value,
      setItem: () => {
        throw Error("quota");
      },
      removeItem: () => {},
    },
    locks: {
      request: async (_name, _options, callback) => {
        grant = callback;
      },
    },
  });
  journal.start(() => {});
  const held = grant({});
  await Promise.resolve();
  journal.save(["memory"]);
  expect(journal.status).toBe("unsaved");
  journal.dispose();
  await held;
  value = JSON.stringify({ version: 2, journalId: "future", entries: [] });
  let lockCalls = 0;
  const future = new PendingSendJournal({
    key: "account",
    reload: true,
    storage: { getItem: () => value, setItem: () => {}, removeItem: () => {} },
    locks: {
      request: async () => {
        lockCalls++;
      },
    },
  });
  future.start(() => {
    throw Error("must not hydrate");
  });
  expect(future.status).toBe("unavailable");
  expect(lockCalls).toBe(0);
});
it("forget clears only an owned namespace, never a waiting predecessor's journal", async () => {
  let removes = 0;
  let grant!: (lock: object | null) => Promise<void>;
  const options = {
    key: "account",
    reload: true,
    storage: {
      getItem: () =>
        JSON.stringify({ version: 1, journalId: "old", entries: [] }),
      setItem: () => {},
      removeItem: () => {
        removes++;
      },
    },
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        grant = callback;
      },
    },
  };
  const waiting = new PendingSendJournal(options);
  waiting.start(() => {});
  waiting.forget();
  expect(removes).toBe(0);
  const owned = new PendingSendJournal(options);
  owned.start(() => {});
  const held = grant({});
  await Promise.resolve();
  owned.forget();
  await held;
  expect(removes).toBe(1);
});
