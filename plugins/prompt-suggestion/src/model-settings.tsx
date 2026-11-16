import { useEffect, useId, useState } from "react";
import {
  useRpc,
  experimental_useRpcQuery,
  useSettings,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contracts.js";

type Models = StandardSchemaV1InferOutput<
  (typeof rpcContract)["models"]["output"]
>;

export function ModelSettings() {
  const inputId = useId();
  const rpc = useRpc<typeof rpcContract>();
  const settings = useSettings();
  const status = experimental_useRpcQuery({
    contract: rpcContract,
    method: "status",
    input: null,
  });
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
      <p role="status" className="text-sm text-muted-foreground">
        {settings.values?.enabled === true ? "Enabled" : "Disabled"} ·{" "}
        {model?.displayName ??
          (selected ? "Selected model unavailable" : "No model selected")}{" "}
        · Reasoning: {String(settings.values?.reasoningEffort ?? "default")} ·
        Requested speed: {String(settings.values?.serviceTier ?? "default")}
      </p>
      <p className="text-xs text-muted-foreground">
        Background preparation:{" "}
        {settings.values?.backgroundPreparation === true
          ? "Enabled"
          : "Disabled"}{" "}
        · Owner instructions:{" "}
        {status.data?.instructionsAvailable ? "Available" : "Unavailable"}
        {status.data?.instructionRevision
          ? ` · Revision: ${status.data.instructionRevision}`
          : ""}
      </p>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={inputId} className="text-sm font-medium">
          Suggestion model
        </label>
        <button
          type="button"
          disabled={loading || saving}
          onClick={() => {
            setRefresh((value) => value + 1);
            void status.refetch();
          }}
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
      {model && (
        <p className="text-xs text-muted-foreground">
          Available reasoning:{" "}
          {model.reasoningEfforts.join(", ") || "provider default only"}.
          Processing speed:{" "}
          {model.serviceTiers.join(", ") || "provider default only"}.
        </p>
      )}
      {model &&
        ((typeof settings.values?.reasoningEffort === "string" &&
          settings.values.reasoningEffort !== "default" &&
          !model.reasoningEfforts.includes(settings.values.reasoningEffort)) ||
          (typeof settings.values?.serviceTier === "string" &&
            settings.values.serviceTier !== "default" &&
            !model.serviceTiers.includes(settings.values.serviceTier))) && (
          <p role="alert" className="text-sm text-destructive">
            This model does not support the selected reasoning or speed. Choose
            a supported value or Provider default.
          </p>
        )}
      {model && !model.supportsOutputLimit && (
        <p className="text-xs text-muted-foreground">
          This model does not support an output token limit. Keep Output token
          limit at 0 to use its default.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The selected provider receives bounded thread context, source-linked
        task state and the full owner BIBLE. Existing BB authentication is
        reused.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
