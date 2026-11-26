// Provider upstreams are code, not configuration. The hub sends every
// account's bearer token to these hosts, so no RPC, CLI, plugin env or stored
// config may change them. Tests override them only through
// createAccountPoolPlugin({ upstreams }), which the shipped default export never
// passes. The network path still follows the daemon's process env
// (HTTP(S)_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED):
// that is the operator's trust boundary, not a pool setting.
export const PROVIDER_UPSTREAMS = Object.freeze({
  anthropic: "https://api.anthropic.com",
  chatgptCodex: "https://chatgpt.com/backend-api/codex",
  openai: "https://api.openai.com/v1",
});

export type ProviderUpstreams = { -readonly [K in keyof typeof PROVIDER_UPSTREAMS]: string };
