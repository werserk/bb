const routingKeys = [
  "BB_THREAD_ID",
  "BB_PROJECT_ID",
  "BB_ENVIRONMENT_ID",
  "BB_SERVER_HEADERS",
  "BB_CLI",
  "BB_SERVER_TOKEN",
  "BB_API_TOKEN",
  "BB_SERVER_URL",
  "BB_APP_URL",
  "BB_EXTERNAL_URL",
  "BB_DATA_DIR",
  "BB_ACCOUNT_POOL_PARENT_URL",
  "BB_ACCOUNT_POOL_PARENT_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

export function assertNoInheritedRouting(env = process.env) {
  if (routingKeys.some((key) => env[key])) {
    throw new Error(
      "Test isolation refused inherited routing. Start with a clean environment; test harnesses must create their own endpoints and data.",
    );
  }
  for (const key of ["BB_SERVER_PORT", "BB_HOST_DAEMON_PORT"]) {
    if (env[key]) {
      throw new Error("Test isolation refused inherited service ports.");
    }
  }
}

export function assertIsolatedPort(port) {
  const value = Number(port);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535 ||
    [38886, 38887, 38900, 38901, 38910, 38911].includes(value)
  ) {
    throw new Error("Test isolation refused service port.");
  }
  return value;
}
