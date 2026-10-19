import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTelemetry, summarizeUsage } from "../src/telemetry.js";
import { createProxyServer } from "../src/proxy.js";
import { loadConfig } from "../src/config.js";

const usage = { input_tokens: 123000, input_tokens_details: { cached_tokens: 121000, cache_write_tokens: 1800 },
  output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 123300 };
function collector() {
  const records = [];
  return { records, logger: { info(meta) { records.push(structuredClone(meta)); }, error(meta) { records.push(structuredClone(meta)); } } };
}
function local(options) {
  const sink = collector();
  return { ...sink, telemetry: createTelemetry({ method: "POST", url: "/openai/v1/responses?secret=DO_NOT_LOG" }, sink.logger, options) };
}
function complete(records) { return records.findLast(record => record.event === "request.completed"); }

test("upstream provider defaults to Azure and accepts a GitHub Copilot bridge URL", () => {
  assert.equal(loadConfig({}).upstreamProvider, "azure");
  assert.equal(loadConfig({}).upstreamBaseUrl, "https://pmagent2.openai.azure.com/openai/v1");
  const copilot = loadConfig({
    UPSTREAM_PROVIDER: "github-copilot",
    COPILOT_PROXY_BASE_URL: "http://127.0.0.1:4141/v1",
    COPILOT_PROXY_API_KEY: "local-key"
  });
  assert.equal(copilot.upstreamProvider, "github-copilot");
  assert.equal(copilot.upstreamBaseUrl, "http://127.0.0.1:4141/v1");
  assert.equal(copilot.copilotProxyApiKey, "local-key");
  assert.throws(() => loadConfig({ UPSTREAM_PROVIDER: "unknown" }), /Invalid UPSTREAM_PROVIDER/);
  assert.throws(() => loadConfig({ UPSTREAM_PROVIDER: "github-copilot" }), /COPILOT_PROXY_API_KEY must be set/);
  assert.throws(() => loadConfig({
    UPSTREAM_PROVIDER: "github-copilot",
    COPILOT_PROXY_API_KEY: "local-key",
    COPILOT_PROXY_BASE_URL: "http://127.0.0.1:4141"
  }), /COPILOT_PROXY_BASE_URL must end in \/v1/);
});

test("request telemetry labels the selected upstream provider", () => {
  const { telemetry, records } = local({ provider: "github-copilot" });
  telemetry.finish();
  assert.equal(complete(records).provider, "github-copilot");
});

test("harness correlation only logs UUID headers and hashes conversation keys", () => {
  const { records, logger } = collector();
  const telemetry = createTelemetry({ method: "POST", url: "/openai/v1/responses",
    headers: { session_id: "12345678-1234-1234-1234-123456789012", "x-request-id": "PRIVATE HEADER" } }, logger,
  { provider: "github-copilot" });
  telemetry.requestPayload({ input: "PRIVATE PROMPT", prompt_cache_key: "PRIVATE CONVERSATION" }, 100);
  telemetry.finish();
  const result = complete(records);
  assert.equal(result.client_session_id, "12345678-1234-1234-1234-123456789012");
  assert.equal(result.client_request_id, null);
  assert.match(result.request.conversation_key_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("Copilot 400 diagnostics log request structure without request values", () => {
  const { telemetry, records } = local({ provider: "github-copilot" });
  telemetry.requestPayload({
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE PROMPT" }] },
      { type: "function_call", name: "PRIVATE TOOL", arguments: "{\"secret\":\"PRIVATE ARGUMENTS\"}" }
    ],
    tools: [{ type: "function", name: "PRIVATE TOOL", parameters: { secret: "PRIVATE SCHEMA" } }],
    reasoning: { effort: "high", summary: "PRIVATE SUMMARY" },
    metadata: { secret: "PRIVATE METADATA" }
  }, 761363);
  telemetry.headers(400, { "content-type": "application/json" });
  telemetry.finish();

  const headers = records.find(record => record.event === "response.headers");
  const completed = complete(records);
  assert.deepEqual(headers.request_shape.top_level_fields, ["input", "metadata", "model", "reasoning", "tools"]);
  assert.deepEqual(headers.request_shape.input.types, { function_call: 1, message: 1 });
  assert.deepEqual(headers.request_shape.content_parts.types, { input_text: 1 });
  assert.deepEqual(headers.request_shape.reasoning_fields, ["effort", "summary"]);
  assert.deepEqual(completed.request_shape, headers.request_shape);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("fragmented CRLF SSE preserves token subsets, error privacy and one completion", () => {
  const { telemetry, records } = local();
  telemetry.requestPayload({ model: "gpt-6-astra", input: "PRIVATE PROMPT", stream: true, reasoning: { effort: "ultra" }, max_output_tokens: 4000, tools: [{ description: "PRIVATE TOOL" }] }, 500);
  telemetry.forwardedPayload({ reasoning: { effort: "high" } }, 499);
  telemetry.headers(200, { "content-type": "text/event-stream", "x-ratelimit-limit-tokens": "1000000",
    "x-ratelimit-remaining-tokens": "456000", "apim-request-id": "upstream-123", "set-cookie": "PRIVATE COOKIE" });
  const stream = `: heartbeat\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: {
    id: "resp_1", model: "gpt-6-astra", status: "completed", output: [{ text: "PRIVATE OUTPUT 你好" }], usage } })}\r\n\r\n`;
  for (const byte of Buffer.from(stream)) telemetry.chunk(Buffer.from([byte]));
  telemetry.finish(); telemetry.finish("transport_error");
  const result = complete(records);
  assert.equal(records.filter(r => r.event === "request.completed").length, 1);
  assert.equal(result.outcome, "completed");
  assert.equal(result.request.requested_reasoning_effort, "ultra");
  assert.equal(result.request.reasoning_effort, "high");
  assert.equal(result.request.max_output_tokens, 4000);
  assert.equal(result.request.body_bytes, 500);
  assert.equal(result.response.usage.uncached_input_tokens, 2000);
  assert.equal(result.response.usage.reasoning_output_tokens, 200);
  assert.equal(result.response.usage.total_tokens, 123300);
  assert.equal(result.response.rate_limits["x-ratelimit-limit-tokens"], "1000000");
  assert.equal(result.response.rate_limits["apim-request-id"], "upstream-123");
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|DO_NOT_LOG|set-cookie/);
});

for (const shape of ["response.failed", "error"]) {
  test(`HTTP 200 ${shape} identifies token limiting with unknown usage`, () => {
    const { telemetry, records } = local();
    telemetry.headers(200, { "content-type": "text/event-stream", "retry-after-ms": "15000" });
    const error = { code: "rate_limit_exceeded", type: "rate_limit_error", message: "SECRET PROMPT has exceeded token rate limit" };
    const value = shape === "error" ? { ...error, type: "error" } : { type: shape, response: { status: "failed", error, usage: null } };
    telemetry.chunk(`data: ${JSON.stringify(value)}\n\n`); telemetry.finish();
    const result = complete(records);
    assert.equal(result.outcome, "response_error");
    assert.equal(result.response.error.limit_kind, "tokens");
    assert.equal(result.response.rate_limits["retry-after-ms"], "15000");
    assert.equal(result.usage_available, false);
    assert.equal(result.response.usage, null);
    assert.doesNotMatch(JSON.stringify(records), /SECRET PROMPT/);
  });
}

test("429 JSON distinguishes provisioned throughput and excludes raw errors", () => {
  const { telemetry, records } = local();
  telemetry.headers(429, { "content-type": "application/json" });
  telemetry.chunk(JSON.stringify({ error: { code: "429", message: "SECRET Requests have exceeded the throughput limit on your Provisioned-Managed deployment." } }));
  telemetry.finish();
  assert.equal(complete(records).outcome, "http_error");
  assert.equal(complete(records).response.error.limit_kind, "provisioned_throughput");
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
});

test("JSON errors labelled text/plain retain code and parameter but never echo messages", () => {
  const { telemetry, records } = local({ provider: "github-copilot", transport: "direct" });
  telemetry.headers(400, { "content-type": "text/plain; charset=utf-8" });
  telemetry.chunk(JSON.stringify({ error: { code: "invalid_request_body", param: "input[3].content",
    message: "PRIVATE PROMPT" } }));
  telemetry.finish();
  const result = complete(records);
  assert.equal(result.response.error.code, "invalid_request_body");
  assert.equal(result.response.error.param, "input[3].content");
  assert.equal(result.response.error.message_present, true);
  assert.equal(result.error_origin, "upstream");
  assert.equal(result.response.observation, "complete");
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("Chat usage chunks and non-stream JSON use the same field names without summing twice", () => {
  const chat = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 10 } };
  for (const sse of [false, true]) {
    const { telemetry, records } = local();
    telemetry.headers(200, { "content-type": sse ? "text/event-stream" : "application/json" });
    const value = JSON.stringify({ id: "chatcmpl-1", model: "model", usage: chat });
    telemetry.chunk(sse ? `data: ${value}\n\ndata: ${value}\n\ndata: [DONE]\n\n` : value);
    telemetry.finish();
    assert.equal(complete(records).response.usage.total_tokens, 120);
    assert.equal(complete(records).response.usage.uncached_input_tokens, 20);
    assert.equal(complete(records).outcome, "completed");
  }
  assert.equal(summarizeUsage(null), null);
  assert.equal(summarizeUsage({ input_tokens: -2 }), null);
});

test("bounded observer recovers after oversized SSE event and never fabricates missing usage", () => {
  const { telemetry, records } = local({ limit: 256 });
  telemetry.headers(200, { "content-type": "text/event-stream" });
  for (let n = 0; n < 20; n++) telemetry.chunk("x".repeat(100));
  telemetry.chunk('\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n');
  telemetry.finish();
  assert.equal(complete(records).response.observation, "size_limit");
  assert.equal(complete(records).response.usage.total_tokens, 6);
  const missing = local();
  missing.telemetry.headers(200, { "content-type": "text/event-stream" });
  missing.telemetry.chunk('data: {"type":"response.created"}\n\n');
  missing.telemetry.finish();
  assert.equal(complete(missing.records).outcome, "stream_interrupted");
  assert.equal(complete(missing.records).usage_available, false);
});

test("request observation is bounded and passes through malformed/encoded input unchanged", async () => {
  for (const [body, inspect] of [["x".repeat(200), true], ["not json", true], ["compressed bytes", false]]) {
    const { telemetry, records } = local({ limit: 100 });
    const result = [];
    for await (const chunk of telemetry.observeRequest([Buffer.from(body.slice(0, 3)), Buffer.from(body.slice(3))], inspect)) result.push(chunk);
    telemetry.finish("transport_error", new Error("SECRET ERROR"));
    assert.equal(Buffer.concat(result).toString(), body);
    assert.equal(complete(records).request.body_bytes, Buffer.byteLength(body));
    assert.equal(complete(records).request.model, null);
    assert.doesNotMatch(JSON.stringify(records), /SECRET ERROR/);
  }
});

test("telemetry sink failure cannot break forwarding", () => {
  const telemetry = createTelemetry({ method: "GET", url: "/openai/v1/models" }, { info() { throw new Error("sink broken"); } });
  telemetry.headers(200, {}); telemetry.chunk("ok"); telemetry.finish();
});

test("real HTTP proxy keeps request, response bytes and headers, records usage and requested/effective reasoning", async t => {
  let forwarded;
  const body = `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n`;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "text/event-stream", "x-ratelimit-remaining-tokens": "999999" });
    res.write(body.slice(0, 41)); res.end(body.slice(41));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const sink = collector();
  const proxy = createProxyServer({ config: loadConfig({ UPSTREAM_AOAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/openai/v1`, STICKY_HIGH_MODELS: "gpt-6-astra" }),
    tokenManager: { async getAccessToken() { return "PRIVATE TOKEN"; } }, logger: sink.logger });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/openai/v1/responses`, { method: "POST",
    body: JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "ultra" }, input: "PRIVATE PROMPT" }), headers: { "content-type": "application/json" } });
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("x-ratelimit-remaining-tokens"), "999999");
  assert.equal(forwarded.reasoning.effort, "high");
  const result = complete(sink.records);
  assert.equal(result.request.requested_reasoning_effort, "ultra");
  assert.equal(result.request.reasoning_effort, "high");
  assert.deepEqual(result.response.usage, summarizeUsage(usage));
  assert.doesNotMatch(JSON.stringify(sink.records), /PRIVATE/);
});


test("compressed responses remain explicitly unobserved and client cancellation is not reported as zero usage", () => {
  const { telemetry, records } = local();
  telemetry.headers(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
  telemetry.chunk(Buffer.from([31, 139, 8]));
  telemetry.finish("client_disconnected"); telemetry.finish("transport_error", new Error("SECRET"));
  const result = complete(records);
  assert.equal(result.outcome, "client_disconnected");
  assert.equal(result.response.observation, "encoded_body");
  assert.equal(result.response.usage, null);
  assert.equal(records.filter(r => r.event === "request.completed").length, 1);
});

test("disconnecting an HTTP client cancels upstream and emits exactly one terminal record", async t => {
  const sink = collector();
  let upstreamClosed = false;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created"}\n\n');
    res.on("close", () => { upstreamClosed = true; });
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createProxyServer({ config: loadConfig({ UPSTREAM_AOAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/openai/v1` }),
    tokenManager: { async getAccessToken() { return "test"; } }, logger: sink.logger });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const server of [proxy, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/openai/v1/responses`, { method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-astra", input: "secret", stream: true }) });
  await response.body.getReader().read();
  controller.abort();
  for (let n = 0; n < 100 && !upstreamClosed; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(upstreamClosed, true);
  assert.equal(sink.records.filter(r => r.event === "request.completed").length, 1);
  assert.equal(complete(sink.records).outcome, "client_disconnected");
  assert.equal(complete(sink.records).request.model, "gpt-6-astra");
  assert.equal(complete(sink.records).usage_available, false);
});


test("client closing after a terminal event keeps the actual model outcome", () => {
  for (const status of ["completed", "failed", "incomplete"]) {
    const { telemetry, records } = local();
    telemetry.headers(200, { "content-type": "text/event-stream" });
    telemetry.chunk(`data: ${JSON.stringify({ type: `response.${status}`, response: { status, usage } })}\n\n`);
    telemetry.finish("client_disconnected");
    const result = complete(records);
    assert.equal(result.outcome, status === "failed" ? "response_error" : status);
    assert.equal(result.client_disconnected, true);
    assert.equal(result.usage_available, true);
  }
});
