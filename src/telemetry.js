import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

// Observation is bounded and never changes forwarded request/response bytes.
const OBSERVATION_LIMIT = 4 * 1024 * 1024;
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null;
const effort = value => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value) ? value : null;
const headerNames = [
  "x-request-id", "apim-request-id", "x-ms-request-id", "x-ms-region",
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
  "x-ratelimit-limit-project-tokens", "x-ratelimit-remaining-project-tokens", "x-ratelimit-reset-project-tokens",
  "retry-after", "retry-after-ms", "x-ms-retry-after-ms"
];

export function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = numeric(usage.input_tokens ?? usage.prompt_tokens);
  const output = numeric(usage.output_tokens ?? usage.completion_tokens);
  const total = numeric(usage.total_tokens);
  if (input === null && output === null && total === null) return null;
  const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const outputDetails = usage.output_tokens_details ?? usage.completion_tokens_details;
  const cached = numeric(inputDetails?.cached_tokens);
  return {
    input_tokens: input, output_tokens: output, total_tokens: total,
    cached_input_tokens: cached, cache_write_input_tokens: numeric(inputDetails?.cache_write_tokens),
    uncached_input_tokens: input !== null && cached !== null && cached <= input ? input - cached : null,
    reasoning_output_tokens: numeric(outputDetails?.reasoning_tokens)
  };
}

function summarizeError(error) {
  if (!error || typeof error !== "object") return null;
  // The message may echo prompt content or credentials. Classify it, never log it.
  const message = typeof error.message === "string" ? error.message : "";
  const code = identifier(error.code), type = identifier(error.type);
  const limitKind = /token.{0,20}rate|tokens per min|\bTPM\b/i.test(message) ? "tokens"
    : /provisioned|throughput unit/i.test(message) ? "provisioned_throughput"
    : /request.{0,20}rate|requests per min|\bRPM\b/i.test(message) ? "requests"
    : /rate.limit|429/i.test(`${code} ${type} ${message}`) ? "unspecified" : null;
  return { code, type, limit_kind: limitKind };
}

export function createTelemetry(req, logger, { limit = OBSERVATION_LIMIT, provider = "azure" } = {}) {
  const started = performance.now();
  const common = { provider, request_id: randomUUID(), started_at: new Date().toISOString(), method: req.method,
    path: req.url.split("?")[0] };
  const request = { model: null, stream: null, requested_reasoning_effort: null, reasoning_effort: null,
    max_output_tokens: null, max_completion_tokens: null, max_tokens: null, input_items: null, tool_count: null,
    body_bytes: 0, forwarded_body_bytes: 0, metadata_status: "not_observed" };
  const response = { status_code: null, model: null, response_id: null, status: null, bytes: 0,
    headers_ms: null, first_byte_ms: null, rate_limits: {}, usage: null, error: null,
    observation: "not_started" };
  let ended = false, terminal = false, parser;
  const emit = (event, severity = "info", extra = {}) => {
    // A failing diagnostics sink must not fail inference.
    try { logger[severity]?.({ ...common, event, ...extra }, event); } catch { /* best effort logging */ }
  };
  emit("request.started");

  function requestPayload(payload, bytes) {
    request.body_bytes = bytes;
    request.forwarded_body_bytes = bytes;
    request.metadata_status = "observed";
    request.model = identifier(payload?.model);
    request.stream = typeof payload?.stream === "boolean" ? payload.stream : null;
    request.requested_reasoning_effort = effort(payload?.reasoning?.effort ?? payload?.reasoning_effort);
    request.reasoning_effort = request.requested_reasoning_effort;
    for (const field of ["max_output_tokens", "max_completion_tokens", "max_tokens"]) request[field] = numeric(payload?.[field]);
    request.input_items = Array.isArray(payload?.input) ? payload.input.length : Array.isArray(payload?.messages) ? payload.messages.length : null;
    request.tool_count = Array.isArray(payload?.tools) ? payload.tools.length : null;
  }
  function forwardedPayload(payload, bytes) {
    request.reasoning_effort = effort(payload?.reasoning?.effort ?? payload?.reasoning_effort);
    request.forwarded_body_bytes = bytes;
  }
  async function* observeRequest(body, inspect) {
    let chunks = [], bytes = 0;
    for await (const chunk of body) {
      bytes += Buffer.byteLength(chunk);
      request.body_bytes = request.forwarded_body_bytes = bytes;
      if (inspect && bytes <= limit) chunks.push(Buffer.from(chunk));
      else chunks = [];
      yield chunk;
    }
    request.metadata_status = !inspect ? "unsupported_body" : bytes > limit ? "size_limit" : "invalid_json";
    if (inspect && bytes <= limit) {
      try { requestPayload(JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes); } catch { /* passthrough */ }
    }
  }
  function observePayload(payload, eventName) {
    if (!payload || typeof payload !== "object") return;
    const event = payload.type ?? eventName;
    const value = payload.response ?? payload;
    response.model = identifier(value.model) ?? response.model;
    response.response_id = identifier(value.id) ?? response.response_id;
    response.status = identifier(value.status) ?? response.status;
    response.usage = summarizeUsage(value.usage) ?? response.usage;
    const error = value.error ?? (event === "error" || (typeof payload.code === "string" && typeof payload.message === "string") ? payload : null);
    if (error) response.error = summarizeError(error);
    if (["response.completed", "response.failed", "response.incomplete", "response.cancelled", "error"].includes(event)) {
      terminal = true;
      response.status = identifier(value.status) ?? event.replace("response.", "");
    }
  }
  function headers(statusCode, values) {
    response.status_code = statusCode;
    response.headers_ms = Math.round(performance.now() - started);
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
    for (const name of headerNames) {
      const value = normalized[name];
      if (typeof value === "string" && value.length <= 256 && /^[\w.,: /+-]+$/.test(value)) response.rate_limits[name] = value;
    }
    const type = String(normalized["content-type"] ?? "").toLowerCase();
    const encoding = String(normalized["content-encoding"] ?? "identity").toLowerCase();
    const sse = type.includes("text/event-stream"), json = type.includes("json");
    response.observation = encoding !== "identity" ? "encoded_body" : sse || json ? "observing" : "unsupported_content_type";
    if (response.observation === "observing") parser = createResponseObserver({ sse, limit, payload: observePayload,
      problem: reason => { response.observation = reason; } });
    emit("response.headers", "info", { request: { ...request }, status_code: statusCode,
      headers_ms: response.headers_ms, rate_limits: { ...response.rate_limits } });
  }
  function chunk(value) {
    if (response.first_byte_ms === null) response.first_byte_ms = Math.round(performance.now() - started);
    response.bytes += Buffer.byteLength(value);
    try { parser?.push(value); } catch { response.observation = "parse_error"; parser = null; }
  }
  function finish(outcome, error) {
    if (ended) return;
    ended = true;
    const clientDisconnected = outcome === "client_disconnected";
    if (clientDisconnected && (terminal || parser?.done || response.error)) outcome = undefined;
    try { parser?.end(); } catch { response.observation = "parse_error"; }
    if (response.observation === "observing") response.observation = "complete";
    outcome ??= response.status_code >= 400 ? "http_error" : response.error || response.status === "failed" || response.status === "error" ? "response_error"
      : response.status === "incomplete" || response.status === "cancelled" ? response.status
      : parser?.sse && !terminal && !parser.done ? "stream_interrupted" : "completed";
    emit("request.completed", outcome.endsWith("error") || outcome === "stream_interrupted" ? "error" : "info", {
      request: { ...request }, response, outcome, duration_ms: Math.round(performance.now() - started),
      usage_available: response.usage !== null, client_disconnected: clientDisconnected,
      ...(error ? { transport_error: { type: identifier(error.name), code: identifier(error.code) } } : {})
    });
  }
  return { requestPayload, forwardedPayload, observeRequest, headers, chunk, finish };
}

function createResponseObserver({ sse, limit, payload, problem }) {
  const decoder = new StringDecoder("utf8");
  let pending = "", dropping = false, done = false, bytes = 0;
  const event = text => {
    const lines = text.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { done = true; return; }
    const eventName = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    try { payload(JSON.parse(data), eventName); } catch { problem("invalid_json"); }
  };
  const consume = text => {
    pending += text;
    if (!sse) return;
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      if (!dropping && boundary.index <= limit) event(pending.slice(0, boundary.index));
      else problem("size_limit");
      pending = pending.slice(boundary.index + boundary[0].length);
      dropping = false;
    }
    if (pending.length > limit) { dropping = true; pending = pending.slice(-3); problem("size_limit"); }
  };
  return {
    sse, get done() { return done; },
    push(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (!sse && bytes > limit) { pending = ""; dropping = true; problem("size_limit"); return; }
      consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    end() {
      consume(decoder.end());
      if (dropping || !pending.trim()) return;
      if (sse) { problem("unterminated_event"); return; }
      try { payload(JSON.parse(pending)); } catch { problem("invalid_json"); }
    }
  };
}
