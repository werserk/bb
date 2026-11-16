import { useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useSdk,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import type { gatewayContract } from "./src/contracts.js";
type Status = StandardSchemaV1InferOutput<
  (typeof gatewayContract)["status"]["output"]
>;
function GatewaySettings() {
  const rpc = useRpc<typeof gatewayContract>();
  const sdk = useSdk();
  const [keyState, setKeyState] = useState<"idle" | "copied" | "error">("idle");
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc
      .call("status", null)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [rpc]);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Use this Base URL with an OpenAI-compatible client. Use this plugin’s
        HTTP token as the API key. Provider credentials stay in BB. A loopback
        URL is reachable only from the BB server machine.
      </p>
      <button
        type="button"
        className="rounded border px-3 py-1"
        onClick={() => {
          void sdk.plugins
            .token({ pluginId: "ai-gateway" })
            .then(({ token }) => navigator.clipboard.writeText(token))
            .then(() => setKeyState("copied"))
            .catch(() => setKeyState("error"));
        }}
      >
        {keyState === "copied" ? "API key copied" : "Copy API key"}
      </button>
      {keyState === "error" && <p role="alert">Could not copy the API key.</p>}
      {error ? (
        <p role="alert">
          Unable to load connected models. Reopen settings to retry.
        </p>
      ) : !status ? (
        <p>Loading models…</p>
      ) : (
        <>
          <label className="block">
            Base URL
            <input
              className="mt-1 w-full rounded border bg-transparent p-2"
              aria-label="Base URL"
              readOnly
              value={status.baseUrl}
            />
          </label>
          <button
            type="button"
            className="rounded border px-3 py-1"
            onClick={() => {
              void navigator.clipboard
                .writeText(status.baseUrl)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy URL"}
          </button>
          <p>
            Use Copy API key to copy this gateway’s token. Never use a
            provider’s API key here.
          </p>
          <p>
            Supported: non-streaming text Chat Completions. Tools, images,
            Responses API and streaming are unavailable. Fast requires support
            from the selected model.
          </p>
          {status.models.length === 0 ? (
            <p>No supported connected models are ready.</p>
          ) : (
            <ul className="space-y-2">
              {status.models.map((model) => (
                <li key={model.id}>
                  <div>
                    {model.displayName} · {model.provider}
                  </div>
                  <code className="break-all">{model.id}</code>
                  <div>
                    {model.profile} · {model.hostId}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "gateway", component: GatewaySettings });
});
