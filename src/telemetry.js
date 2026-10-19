import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { inspectRequest } from "./request-diagnostics.js";

// Observation is bounded and never changes forwarded request/response bytes.
const OBSERVATION_LIMIT = 4 * 1024 * 1024;
const numeric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) ? value : null;
const effort = value => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value) ? value : null;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value : null;
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
  const param = typeof error.param === "string" && /^[a-zA-Z_][\w.[\]-]{0,159}$/.test(error.param) ? error.param : null;
  return { code, type, param, message_present: message.length > 0, limit_kind: limitKind };
}

function summarizeTypedItems(items) {
  const types = new Map();
  const fieldsByType = new Map();
  for (const item of items) {
    const candidate = identifier(item?.type ?? item?.role) ?? "other";
    const type = types.has(candidate) || types.size < 32 ? candidate : "other";
    types.set(type, (types.get(type) ?? 0) + 1);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const fields = fieldsByType.get(type) ?? new Set();
      for (const key of Object.keys(item).slice(0, 32)) {
        if (/^[\w.-]{1,80}$/.test(key)) fields.add(key);
      }
      fieldsByType.set(type, fields);
    }
  }
  return {
    count: items.length,
    types: Object.fromEntries([...types].sort(([a], [b]) => a.localeCompare(b))),
    fields_by_type: Object.fromEntries([...fieldsByType]
      .map(([type, fields]) => [type, [...fields].sort().slice(0, 32)]))
  };
}

function summarizeRequestShape(payload) {
  const fields = payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : [];
  const input = Array.isArray(payload?.input) ? payload.input
    : Array.isArray(payload?.messages) ? payload.messages : null;
  const tools = Array.isArray(payload?.tools) ? payload.tools : null;
  const contentParts = input?.flatMap(item => Array.isArray(item?.content) ? item.content : []) ?? [];
  return {
    top_level_fields: fields.filter(key => /^[\w.-]{1,80}$/.test(key)).sort().slice(0, 64),
    input_kind: typeof payload?.input === "string" ? "string" : input ? "array" : "other",
    ...(input ? { input: summarizeTypedItems(input), content_parts: summarizeTypedItems(contentParts) } : {}),
    ...(tools ? { tools: summarizeTypedItems(tools) } : {}),
    ...(payload?.reasoning && typeof payload.reasoning === "object" && !Array.isArray(payload.reasoning)
      ? { reasoning_fields: Object.keys(payload.reasoning).filter(key => /^[\w.-]{1,80}$/.test(key)).sort().slice(0, 32) }
      : {})
  };
}

export function createTelemetry(req, logger, { limit = OBSERVATION_LIMIT, provider = "azure", transport } = {}) {
  const started = performance.now();
  const common = { provider, request_id: randomUUID(), started_at: new Date().toISOString(), method: req.method,
    path: req.url.split("?")[0], ...(transport ? { transport } : {}),
    client_session_id: uuid(req.headers?.session_id ?? req.headers?.["x-codex-session-id"]),
    client_request_id: uuid(req.headers?.["x-client-request-id"] ?? req.headers?.["x-request-id"]) };
  const request = { model: null, stream: null, requested_reasoning_effort: null, reasoning_effort: null,
    max_output_tokens: null, max_completion_tokens: null, max_tokens: null, input_items: null, tool_count: null,
    body_bytes: 0, forwarded_body_bytes: 0, metadata_status: "not_observed" };
  const response = { status_code: null, model: null, response_id: null, status: null, bytes: 0,
    headers_ms: null, first_byte_ms: null, rate_limits: {}, usage: null, error: null,
    content_type: null, event_counts: {}, observation: "not_started" };
  let requestShape = null, forwardedShape = null, requestDiagnostics = null;
  let stage = "request", originalHash = null, forwardedHash = null, clientStatus = null;
  let ended = false, terminal = false, parser;
  const emit = (event, severity = "info", extra = {}) => {
    // A failing diagnostics sink must not fail inference.
    try { logger[severity]?.({ ...common, event, ...extra }, event); } catch { /* best effort logging */ }
  };
  emit("request.started");

  function requestBody(body) {
    request.body_bytes = request.forwarded_body_bytes = Buffer.byteLength(body);
    request.metadata_status = "invalid_json";
    originalHash = forwardedHash = hash(body);
  }

  function requestPayload(payload, bytes, body) {
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
    request.conversation_key_sha256 = typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.length <= 1024
      ? hash(payload.prompt_cache_key) : null;
    requestShape = provider === "github-copilot" ? summarizeRequestShape(payload) : null;
    requestDiagnostics = provider === "github-copilot" && payload && typeof payload === "object" && !Array.isArray(payload)
      ? inspectRequest(payload) : null;
    if (body !== undefined) originalHash = forwardedHash = hash(body);
  }
  function forwardedPayload(payload, bytes, body) {
    request.reasoning_effort = effort(payload?.reasoning?.effort ?? payload?.reasoning_effort);
    request.forwarded_body_bytes = bytes;
    forwardedShape = provider === "github-copilot" ? summarizeRequestShape(payload) : null;
    if (body !== undefined) forwardedHash = hash(body);
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
      try {
        const body = Buffer.concat(chunks);
        requestPayload(JSON.parse(body.toString("utf8")), bytes, body);
      } catch { /* passthrough */ }
    }
  }
  function observePayload(payload, eventName) {
    if (!payload || typeof payload !== "object") return;
    const event = payload.type ?? eventName;
    const knownEvents = ["response.created", "response.in_progress", "response.completed", "response.failed",
      "response.incomplete", "response.cancelled", "response.output_item.added", "response.output_item.done",
      "response.output_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta", "error"];
    const eventKey = knownEvents.includes(event) ? event : "other";
    response.event_counts[eventKey] = (response.event_counts[eventKey] ?? 0) + 1;
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
    response.content_type = /^[\w.+/-]+(?:;\s*charset=[\w-]+)?$/.test(type) ? type : null;
    const encoding = String(normalized["content-encoding"] ?? "identity").toLowerCase();
    // Some upstream errors contain JSON but are labelled text/plain or omit a
    // content type. Parse bounded error bodies without ever logging raw text.
    const sse = type.includes("text/event-stream"), json = type.includes("json") || statusCode >= 400;
    response.observation = encoding !== "identity" ? "encoded_body" : sse || json ? "observing" : "unsupported_content_type";
    if (response.observation === "observing") parser = createResponseObserver({ sse, limit, payload: observePayload,
      problem: reason => { response.observation = reason; } });
    emit("response.headers", "info", { request: { ...request }, status_code: statusCode,
      headers_ms: response.headers_ms, rate_limits: { ...response.rate_limits },
      ...(statusCode === 400 && requestShape ? { request_shape: requestShape } : {}) });
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
      client_status_code: clientStatus ?? response.status_code,
      stage, error_origin: outcome === "request_error" ? "local_validation"
        : outcome === "authentication_error" ? "authentication"
        : outcome === "http_error" || outcome === "response_error" ? "upstream"
        : outcome === "transport_error" ? "transport" : null,
      request_body_sha256: originalHash, forwarded_body_sha256: forwardedHash,
      ...(requestDiagnostics ? { request_diagnostics: requestDiagnostics } : {}),
      ...(response.status_code === 400 && requestShape ? { request_shape: requestShape } : {}),
      ...(error ? { transport_error: { type: identifier(error.name), code: identifier(error.code) } } : {})
    });
  }
  function prepared(changes = []) {
    emit("request.prepared", "info", { request: { ...request }, changes,
      request_body_sha256: originalHash, forwarded_body_sha256: forwardedHash,
      ...(requestShape ? { request_shape: requestShape, forwarded_shape: forwardedShape ?? requestShape,
        request_diagnostics: requestDiagnostics } : {}) });
  }
  return { requestPayload, requestBody, forwardedPayload, observeRequest, headers, chunk, finish, prepared,
    requestId: common.request_id,
    localStatus(value) { clientStatus = value; },
    stage(value) { stage = value; },
    event(name, extra) { emit(name, "info", extra); } };
}

function hash(body) {
  return createHash("sha256").update(body).digest("hex");
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
