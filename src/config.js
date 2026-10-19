const DEFAULTS = {
  UPSTREAM_PROVIDER: "azure",
  LISTEN_HOST: "127.0.0.1",
  LISTEN_PORT: "17777",
  UPSTREAM_AOAI_BASE_URL: "https://pmagent2.openai.azure.com/openai/v1",
  COPILOT_PROXY_BASE_URL: "http://127.0.0.1:4141/v1",
  AZURE_OPENAI_SCOPE: "https://cognitiveservices.azure.com/.default",
  TOKEN_REFRESH_BUFFER_MS: String(5 * 60 * 1000),
  UPSTREAM_HEADERS_TIMEOUT_MS: String(30 * 1000),
  UPSTREAM_BODY_TIMEOUT_MS: String(10 * 60 * 1000),
  STICKY_HIGH_MODELS: "",
  STICKY_HIGH_MAX_BODY_BYTES: String(32 * 1024 * 1024)
};

function parsePositiveInt(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const upstreamProvider = env.UPSTREAM_PROVIDER ?? DEFAULTS.UPSTREAM_PROVIDER;
  if (!["azure", "github-copilot"].includes(upstreamProvider)) {
    throw new Error(`Invalid UPSTREAM_PROVIDER: ${upstreamProvider}`);
  }
  const copilotTransport = env.COPILOT_TRANSPORT ?? "bridge";
  if (!["bridge", "direct"].includes(copilotTransport)) throw new Error("Invalid COPILOT_TRANSPORT");
  const copilotAccountType = env.COPILOT_ACCOUNT_TYPE ?? "individual";
  if (!["individual", "business", "enterprise"].includes(copilotAccountType)) throw new Error("Invalid COPILOT_ACCOUNT_TYPE");

  const listenHost = env.LISTEN_HOST ?? DEFAULTS.LISTEN_HOST;
  const listenPort = parsePositiveInt(env, "LISTEN_PORT", DEFAULTS.LISTEN_PORT);

  const nativeCopilot = upstreamProvider === "github-copilot" && copilotTransport === "direct";
  const upstreamBaseUrl = nativeCopilot
    ? copilotAccountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${copilotAccountType}.githubcopilot.com`
    : upstreamProvider === "github-copilot" ? env.COPILOT_PROXY_BASE_URL ?? DEFAULTS.COPILOT_PROXY_BASE_URL
    : env.UPSTREAM_AOAI_BASE_URL ?? DEFAULTS.UPSTREAM_AOAI_BASE_URL;
  if (!/^https?:\/\//.test(upstreamBaseUrl)) {
    throw new Error(`${upstreamProvider === "github-copilot" ? "COPILOT_PROXY_BASE_URL" : "UPSTREAM_AOAI_BASE_URL"} must be an absolute URL, got: ${upstreamBaseUrl}`);
  }
  if (upstreamProvider === "github-copilot" && !nativeCopilot && new URL(upstreamBaseUrl).pathname.replace(/\/$/, "") !== "/v1") {
    throw new Error("COPILOT_PROXY_BASE_URL must end in /v1");
  }

  const copilotProxyApiKey = env.COPILOT_PROXY_API_KEY?.trim() ?? "";
  if (upstreamProvider === "github-copilot" && copilotTransport === "bridge" && !copilotProxyApiKey) {
    throw new Error("COPILOT_PROXY_API_KEY must be set when UPSTREAM_PROVIDER=github-copilot");
  }

  const scope = env.AZURE_OPENAI_SCOPE ?? DEFAULTS.AZURE_OPENAI_SCOPE;
  const tokenRefreshBufferMs = parsePositiveInt(env, "TOKEN_REFRESH_BUFFER_MS", DEFAULTS.TOKEN_REFRESH_BUFFER_MS);
  const upstreamHeadersTimeoutMs = parsePositiveInt(env, "UPSTREAM_HEADERS_TIMEOUT_MS", DEFAULTS.UPSTREAM_HEADERS_TIMEOUT_MS);
  const upstreamBodyTimeoutMs = parsePositiveInt(env, "UPSTREAM_BODY_TIMEOUT_MS", DEFAULTS.UPSTREAM_BODY_TIMEOUT_MS);
  const stickyHighModels = [...new Set((env.STICKY_HIGH_MODELS ?? DEFAULTS.STICKY_HIGH_MODELS)
    .split(",").map((model) => model.trim()).filter(Boolean))];
  const stickyHighMaxBodyBytes = parsePositiveInt(env, "STICKY_HIGH_MAX_BODY_BYTES", DEFAULTS.STICKY_HIGH_MAX_BODY_BYTES);

  return {
    upstreamProvider,
    copilotTransport,
    copilotAccountType,
    copilotTokenFile: env.COPILOT_TOKEN_FILE || undefined,
    listenHost,
    listenPort,
    upstreamBaseUrl,
    copilotProxyApiKey,
    scope,
    tokenRefreshBufferMs,
    upstreamHeadersTimeoutMs,
    upstreamBodyTimeoutMs,
    stickyHighModels,
    stickyHighMaxBodyBytes
  };
}
