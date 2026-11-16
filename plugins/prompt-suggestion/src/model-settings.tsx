import { useEffect, useId, useState } from "react";
import {
  useRpc,
  useSettings,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contracts.js";

type Models = StandardSchemaV1InferOutput<
  (typeof rpcContract)["models"]["output"]
>;

export function ModelSettings() {
  const inputId = useId();
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const [models, setModels] = useState<Models>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const selected =
    typeof settings.values?.model === "string" ? settings.values.model : "";
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void rpc
      .call("models")
      .then((next) => {
        if (active) setModels(next);
      })
      .catch(() => {
        if (active)
          setError(
            "Could not load models. Check the provider connection and try again.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [rpc, refresh]);
  const model = models.find((item) => item.id === selected);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-medium">
          Suggestion model
        </label>
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => setRefresh((value) => value + 1)}
          className="text-sm underline disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      <select
        id={inputId}
        aria-label="Suggestion model"
        value={selected}
        disabled={loading || saving}
        className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
        onChange={(event) => {
          const next = event.target.value;
          setSaving(true);
          setError(null);
          void rpc
            .call("selectModel", { model: next })
            .catch(() => {
              setError(
                "Could not select this model. Refresh the available models and try again.",
              );
            })
            .finally(() => setSaving(false));
        }}
      >
        <option value="">Choose a model</option>
        {selected && !model && (
          <option value={selected}>Selected model is unavailable</option>
        )}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.provider} · {item.displayName} · {item.profile} ({item.hostId}
            )
          </option>
        ))}
      </select>
      {loading ? (
        <p className="text-xs text-muted-foreground">
          Loading connected models…
        </p>
      ) : models.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No compatible models are available. Connect a supported provider on
          your primary machine, then refresh.
        </p>
      ) : null}
      {model && !model.supportsOutputLimit && (
        <p className="text-xs text-muted-foreground">
          This model does not support an output token limit. Keep Output token
          limit at 0 to use its default.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The selected provider receives recent text from the current thread.
        Existing BB authentication is reused.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
