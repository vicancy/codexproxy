import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "undici";
import { CopilotTokenManager, loginCopilot, saveCopilotCredential, readCopilotCredential } from "../src/copilot-auth.js";
import { adaptCopilotResponses, createCopilotClient } from "../src/copilot.js";
import { loadConfig } from "../src/config.js";
import { createProxyServer } from "../src/proxy.js";
import { inspectRequest } from "../src/request-diagnostics.js";

const quiet = { info() {}, error() {} };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function credential(t) {
  const dir = await mkdtemp(join(tmpdir(), "codexproxy-test-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "credentials", "github_token");
  await saveCopilotCredential(path, "PRIVATE_GITHUB_TOKEN");
  return path;
}

test("native configuration is explicit and bridge deployments keep their defaults", () => {
  const config = loadConfig({ UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct" });
  assert.equal(config.copilotTransport, "direct");
  assert.equal(config.copilotAccountType, "individual");
  assert.equal(config.upstreamBaseUrl, "https://api.githubcopilot.com");
  assert.equal(loadConfig({ UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct",
    COPILOT_ACCOUNT_TYPE: "enterprise", COPILOT_PROXY_BASE_URL: "" }).upstreamBaseUrl, "https://api.enterprise.githubcopilot.com");
  assert.equal(loadConfig({}).copilotTransport, "bridge");
  assert.throws(() => loadConfig({ COPILOT_TRANSPORT: "unknown" }), /COPILOT_TRANSPORT/);
  assert.throws(() => loadConfig({ COPILOT_ACCOUNT_TYPE: "arbitrary-host" }), /COPILOT_ACCOUNT_TYPE/);
});

test("credential writes are private and atomic and broad permissions are rejected", async t => {
  const path = await credential(t);
  assert.equal(await readFile(path, "utf8"), "PRIVATE_GITHUB_TOKEN");
  assert.equal(await readCopilotCredential(path), "PRIVATE_GITHUB_TOKEN");
  await saveCopilotCredential(path, "NEW_PRIVATE_TOKEN");
  assert.equal(await readCopilotCredential(path), "NEW_PRIVATE_TOKEN");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(readCopilotCredential(path), /private regular file/);
  }
});

test("token renewals coalesce and refresh a rejected token only once", async t => {
  const path = await credential(t);
  let now = 1000, calls = 0;
  const records = [];
  const manager = new CopilotTokenManager({
    tokenFile: path, now: () => now,
    logger: { info(record) { records.push(record); }, error(record) { records.push(record); } },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(options.headers.authorization, "token PRIVATE_GITHUB_TOKEN");
      calls++;
      return json({ token: `PRIVATE_COPILOT_${calls}`, expires_at: (now + 120_000) / 1000 });
    }
  });
  const tokens = await Promise.all(Array.from({ length: 8 }, () => manager.getAccessToken()));
  assert.equal(calls, 1);
  assert.equal(new Set(tokens).size, 1);
  await Promise.all(Array.from({ length: 8 }, () => manager.getAccessToken({ staleToken: tokens[0] })));
  assert.equal(calls, 2);
  await manager.getAccessToken({ staleToken: tokens[0] });
  assert.equal(calls, 2);
  now += 90_000;
  await manager.getAccessToken();
  assert.equal(calls, 3);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("authentication failures are explicit, do not log response bodies, and recover on next request", async t => {
  const path = await credential(t);
  const records = [];
  let fail = true;
  const manager = new CopilotTokenManager({ tokenFile: path,
    logger: { info(record) { records.push(record); }, error(record) { records.push(record); } },
    fetchImpl: async () => fail ? json({ message: "PRIVATE TOKEN" }, 403)
      : json({ token: "PRIVATE_COPILOT", expires_at: Date.now() / 1000 + 120 })
  });
  await assert.rejects(manager.getAccessToken(), /Copilot login unavailable/);
  fail = false;
  assert.equal(await manager.getAccessToken(), "PRIVATE_COPILOT");
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("device login respects pending, slow_down, expiry, and never prints access tokens", async t => {
  const path = await credential(t);
  let now = 0, calls = 0;
  const messages = [], delays = [];
  await loginCopilot({
    tokenFile: path, now: () => now, announce: value => messages.push(value),
    wait: async ms => { delays.push(ms); now += ms; },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return json({ device_code: "PRIVATE_DEVICE", user_code: "USER-CODE",
        verification_uri: "https://github.com/login/device", expires_in: 60, interval: 1 });
      if (calls === 2) return json({ error: "authorization_pending" });
      if (calls === 3) return json({ error: "slow_down" });
      return json({ access_token: "PRIVATE_NEW_TOKEN" });
    }
  });
  assert.deepEqual(delays, [1000, 1000, 6000]);
  assert.equal(await readCopilotCredential(path), "PRIVATE_NEW_TOKEN");
  assert.doesNotMatch(messages.join("\n"), /PRIVATE/);

  now = 0;
  calls = 0;
  await assert.rejects(loginCopilot({
    tokenFile: path, now: () => now, announce() {},
    wait: async ms => { now += ms; },
    fetchImpl: async () => ++calls === 1 ? json({ device_code: "PRIVATE_DEVICE", user_code: "CODE",
      verification_uri: "https://github.com/login/device", expires_in: 2, interval: 1 })
      : json({ error: "authorization_pending" })
  }), /expired/);
});

test("Astra adaptation is surgical and never strips encrypted history or tool results", () => {
  const payload = { model: "gpt-6-astra", service_tier: "fast", temperature: 1, top_p: 1,
    top_logprobs: 4, include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
    reasoning: { effort: "xhigh", summary: "auto" },
    input: [{ type: "reasoning", encrypted_content: "PRIVATE_REASONING" },
      { type: "custom_tool_call_output", call_id: "c1", output: "PRIVATE_OUTPUT" }] };
  const copy = structuredClone(payload);
  const result = adaptCopilotResponses(payload);
  assert.deepEqual(payload, copy);
  assert.deepEqual(result.payload.input, payload.input);
  assert.deepEqual(result.payload.reasoning, payload.reasoning);
  assert.deepEqual(result.payload.include, ["reasoning.encrypted_content"]);
  assert.equal(result.payload.service_tier, undefined);
  assert.equal(result.payload.temperature, undefined);
  assert.equal(result.changes.length, 5);
  assert.doesNotMatch(JSON.stringify(result.changes), /PRIVATE/);
});

test("request audits identify harness call/output inconsistencies without exposing IDs or arguments", () => {
  const diagnostics = inspectRequest({ input: [
    { type: "reasoning", encrypted_content: "PRIVATE" },
    { type: "additional_tools", tools: [{ name: "PRIVATE" }] },
    { type: "function_call", call_id: "PRIVATE_CALL", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "PRIVATE_CALL", output: "PRIVATE" },
    { type: "custom_tool_call_output", call_id: "PRIVATE_CALL", output: "PRIVATE" },
    { type: "function_call_output", call_id: "PRIVATE_MISSING", output: "PRIVATE" }
  ] });
  assert.equal(diagnostics.encrypted_reasoning_items, 1);
  assert.equal(diagnostics.embedded_tool_count, 1);
  assert.ok(diagnostics.issues.some(issue => issue.code === "orphan_tool_output" && issue.path === "input[5].call_id"));
  assert.ok(diagnostics.issues.some(issue => issue.code === "tool_call_type_mismatch"));
  assert.ok(diagnostics.issues.some(issue => issue.code === "duplicate_tool_output"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
  const bounded = inspectRequest({ input: Array.from({ length: 100 }, () => null) });
  assert.equal(bounded.issue_count, 100);
  assert.equal(bounded.issues.length, 20);
  assert.equal(bounded.issues_truncated, true);
});

test("native transport only retries auth rejections, preserves 429, and never forwards client credentials", async () => {
  for (const statuses of [[401, 200], [403, 403], [429], [400], [503]]) {
    const calls = [], auth = [], events = [];
    const client = createCopilotClient({
      config: { copilotAccountType: "individual" },
      tokenManager: { async getAccessToken(options) { auth.push(options); return auth.length === 1 ? "OLD_TOKEN" : "NEW_TOKEN"; } },
      async requestImpl(url, options) {
        calls.push({ url, options });
        return { statusCode: statuses[calls.length - 1], headers: {}, body: { async dump() {} } };
      }
    });
    const result = await client.request("/openai/v1/responses", { method: "POST", body: "{}", stream: true,
      headers: { authorization: "PRIVATE_CLIENT", cookie: "PRIVATE_COOKIE" } },
    { stage() {}, event(name, data) { events.push({ name, ...data }); } });
    assert.equal(calls.length, statuses.length);
    assert.equal(result.statusCode, statuses.at(-1));
    assert.equal(calls[0].url.href, "https://api.githubcopilot.com/responses");
    assert.equal(calls[0].options.headers.authorization, "Bearer OLD_TOKEN");
    assert.equal(calls[0].options.headers.cookie, undefined);
    assert.equal(calls[0].options.headers.accept, "text/event-stream");
    if (calls.length === 2) {
      assert.deepEqual(auth[1], { staleToken: "OLD_TOKEN" });
      assert.equal(calls[1].options.headers.authorization, "Bearer NEW_TOKEN");
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|OLD_TOKEN|NEW_TOKEN/);
  }
});

test("native proxy correlates unmodified SSE, usage, adaptation, headers and redacted request structure", async t => {
  const records = [], captured = [];
  const responseBody = `data: ${JSON.stringify({ type: "response.completed", response: {
    id: "resp_test", status: "completed", usage: { input_tokens: 123, output_tokens: 7, total_tokens: 130,
      input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 3 } }
  } })}\n\n`;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "copilot-test",
      "x-ratelimit-remaining-tokens": "999", "x-codexproxy-request-id": "do-not-overwrite-local-id" });
    res.end(responseBody);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const config = loadConfig({ UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct", STICKY_HIGH_MODELS: "gpt-6-astra" });
  const client = createCopilotClient({ config, tokenManager: { async getAccessToken() { return "PRIVATE_COPILOT"; } },
    requestImpl: (url, options) => request(`http://127.0.0.1:${upstream.address().port}${url.pathname}`, options) });
  const proxy = createProxyServer({ config, copilotClient: client,
    logger: { info(record) { records.push(structuredClone(record)); }, error(record) { records.push(structuredClone(record)); } } });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });
  const body = JSON.stringify({ model: "gpt-6-astra", stream: true, input: "PRIVATE_PROMPT",
    service_tier: "fast", reasoning: { effort: "xhigh" } });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/openai/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", cookie: "PRIVATE_COOKIE" }, body
  });
  assert.equal(await response.text(), responseBody);
  const completed = records.findLast(record => record.event === "request.completed");
  assert.equal(response.headers.get("x-codexproxy-request-id"), completed.request_id);
  assert.equal(completed.transport, "direct");
  assert.equal(completed.response.usage.total_tokens, 130);
  assert.equal(completed.response.usage.cached_input_tokens, 100);
  assert.equal(completed.response.usage.reasoning_output_tokens, 3);
  assert.equal(completed.response.rate_limits["x-request-id"], "copilot-test");
  assert.equal(completed.response.event_counts["response.completed"], 1);
  assert.equal(completed.request_body_sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(completed.forwarded_body_sha256, createHash("sha256").update(captured[0].body).digest("hex"));
  assert.notEqual(completed.request_body_sha256, completed.forwarded_body_sha256);
  assert.equal(JSON.parse(captured[0].body).reasoning.effort, "high");
  assert.equal(JSON.parse(captured[0].body).service_tier, undefined);
  assert.equal(captured[0].headers.cookie, undefined);
  assert.ok(records.some(record => record.event === "request.prepared" && record.changes.length === 2));
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
});

test("native readiness failures and unsupported paths are explicit", async t => {
  const config = loadConfig({ UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct" });
  const proxy = createProxyServer({ config, logger: quiet,
    copilotClient: { async checkReady() { throw new Error("PRIVATE INTERNAL"); } } });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).error, "upstream_unavailable");
  const unsupported = await fetch(`${base}/openai/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(unsupported.status, 501);
  assert.ok(unsupported.headers.get("x-codexproxy-request-id"));
  const method = await fetch(`${base}/openai/v1/models`, { method: "POST", body: "{}" });
  assert.equal(method.status, 405);
});

test("native payload bounds apply to exact UTF-8 bytes before and after adaptation", async t => {
  const body = JSON.stringify({ model: "gpt-6-astra", input: "你好" });
  for (const sticky of [false, true]) {
    let requests = 0;
    const records = [];
    const config = loadConfig({ UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct",
      STICKY_HIGH_MODELS: sticky ? "gpt-6-astra" : "", STICKY_HIGH_MAX_BODY_BYTES: String(Buffer.byteLength(body)) });
    const proxy = createProxyServer({ config,
      logger: { info(record) { records.push(record); }, error(record) { records.push(record); } },
      copilotClient: { async request(path, options) {
        requests++;
        assert.equal(Buffer.byteLength(options.body), Buffer.byteLength(body));
        return { statusCode: 200, headers: { "content-type": "application/json" },
          body: (async function* () { yield "{}"; })() };
      } } });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => proxy.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/openai/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    await response.text();
    assert.equal(response.status, sticky ? 413 : 200);
    assert.equal(requests, sticky ? 0 : 1);
    const completed = records.findLast(record => record.event === "request.completed");
    assert.equal(completed.client_status_code, response.status);
    if (sticky) assert.equal(completed.error_origin, "local_validation");
  }
});
