import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { nativePoolContract } from "./native-surface.js";
import type { NativePool } from "./native-pool.js";
export function NativeWorkers() {
  const rpc = useRpc<typeof nativePoolContract>();
  const [state, setState] = useState<ReturnType<NativePool["status"]> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [cell, setCell] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      setState(await rpc.call("native.status", null));
      setError("");
    } catch {
      setError("Native worker status unavailable");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch {
      setError(
        "Operation outcome unavailable. Keep the same submission key and reconcile.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Native workers"
      className="min-w-0 max-w-full space-y-4 py-4"
    >
      <h3>Native workers</h3>
      <p>
        {state?.enabled && state.qualified
          ? "Qualified controller"
          : "Disabled / unqualified — no native execution"}
      </p>
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} onClick={() => void refresh()}>
        Refresh status
      </Button>{" "}
      <Button
        disabled={busy}
        onClick={() => void act(() => rpc.call("native.reconcile", null))}
      >
        Reconcile
      </Button>
      <div
        className="max-w-full overflow-x-auto rounded-md border border-border"
        tabIndex={0}
        aria-label="Native worker details"
      >
        <table className="w-full min-w-[680px] text-left text-sm [&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
          <thead>
            <tr>
              <th>Account / machine</th>
              <th>Runtime workspace</th>
              <th>Owner SSH target</th>
              <th>Resident / hold</th>
              <th>Queued</th>
            </tr>
          </thead>
          <tbody>
            {state?.cells.map((c) => {
              const slot = state.slots.find((s) => s.cellId === c.id);
              return (
                <tr key={c.id}>
                  <td>
                    {c.label} / {c.hostId}
                  </td>
                  <td>{c.workspace}</td>
                  <td>{c.sshTarget}</td>
                  <td>
                    {slot?.threadId ?? "None"} · {slot?.phase} ·{" "}
                    {slot?.epoch ?? "Unobserved"}
                  </td>
                  <td>
                    {
                      state.intents.filter(
                        (i) =>
                          (i.cellId === c.id || i.requestedCell === c.id) &&
                          i.phase === "waiting",
                      ).length
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form
        className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await rpc.call("native.submit", {
              submissionKey: key,
              projectId: project,
              input: task,
              ...(cell ? { cellId: cell } : {}),
            });
            setKey(crypto.randomUUID());
            setTask("");
          });
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          Project ID
          <Input
            required
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          Task
          <textarea
            className="min-h-24 w-full min-w-0 rounded-md border border-border bg-background p-2"
            required
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          Cell
          <select
            className="w-full min-w-0 rounded-md border border-border bg-background p-2"
            value={cell}
            onChange={(e) => setCell(e.target.value)}
          >
            <option value="">Any available worker</option>
            {state?.cells.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Button className="self-end" disabled={busy}>
          Submit
        </Button>
      </form>
      {state?.intents.map((i) => (
        <div
          key={i.id}
          className="flex min-w-0 items-start gap-3 rounded-md border border-border p-3 text-sm"
        >
          <div className="min-w-0 flex-1 break-all">
            {i.id} · {i.phase} · {i.threadId ?? "No thread"} ·{" "}
            {i.queueId ?? "No confirmed custody"} {i.detail}
          </div>
          <Button
            disabled={
              busy || i.phase === "cancelled" || i.phase === "cancelling"
            }
            onClick={() =>
              void act(() => rpc.call("native.stop", { intentId: i.id }))
            }
          >
            Stop
          </Button>
        </div>
      ))}
    </section>
  );
}
