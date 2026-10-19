import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { loadConfig } from "../src/config.js";
import { createProxyServer } from "../src/proxy.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t, { env = {}, statusCode = 200 } = {}) {
  const requests = [];
  const stream = 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n';
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(statusCode, { "content-type": "text/event-stream", "x-upstream": "preserved" });
    res.write(stream.slice(0, 20));
    res.end(stream.slice(20));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    config: loadConfig({
      UPSTREAM_AOAI_BASE_URL: `${upstreamUrl}/openai/v1`,
      STICKY_HIGH_MODELS: "gpt-6-astra",
      ...env
    }),
    tokenManager: { async getAccessToken() { return "test-token"; } },
    logger: { info() {}, error() {} }
  });
  const url = await listen(proxy);
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  return { url, requests, stream };
}

function sendChunked(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(body.subarray(0, 16));
    req.end(body.subarray(16));
  });
}

test("Sticky High config is opt-in and normalizes exact deployment names", () => {
  assert.deepEqual(loadConfig({}).stickyHighModels, []);
  assert.equal(loadConfig({}).stickyHighMaxBodyBytes, 32 * 1024 * 1024);
  assert.deepEqual(loadConfig({ STICKY_HIGH_MODELS: " gpt-6-astra, custom, gpt-6-astra, , " }).stickyHighModels,
    ["gpt-6-astra", "custom"]);
  assert.equal(loadConfig({ STICKY_HIGH_MAX_BODY_BYTES: "1024" }).stickyHighMaxBodyBytes, 1024);
  for (const value of ["0", "-1", "1.5", "bad", "Infinity", ""]) {
    assert.throws(() => loadConfig({ STICKY_HIGH_MAX_BODY_BYTES: value }), /Invalid STICKY_HIGH_MAX_BODY_BYTES/);
  }
});

for (const effort of ["medium", "low", "xhigh", "high", undefined]) {
  test(`Responses pins ${effort ?? "missing"} effort while preserving other fields and SSE`, async (t) => {
    const { url, requests, stream } = await setup(t);
    const payload = {
      model: "gpt-6-astra", input: "你好", stream: true, store: false,
      reasoning: { effort, summary: "auto" }, metadata: { test: "preserved" }
    };
    const response = await fetch(`${url}/openai/v1/responses?api-version=preview`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-upstream"), "preserved");
    assert.equal(await response.text(), stream);
    assert.equal(requests[0].url, "/openai/v1/responses?api-version=preview");
    assert.deepEqual(JSON.parse(requests[0].body), { ...payload, reasoning: { effort: "high", summary: "auto" } });
    assert.equal(Number(requests[0].headers["content-length"]), requests[0].body.length);
    assert.equal(requests[0].headers["transfer-encoding"], undefined);
  });
}

test("Responses adds missing reasoning and replaces chunked framing with accurate byte length", async (t) => {
  const { url, requests } = await setup(t);
  const body = Buffer.from(JSON.stringify({ model: "gpt-6-astra", input: "你好" }));
  const response = await sendChunked(`${url}/openai/v1/responses/`, body);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(requests[0].body).reasoning, { effort: "high" });
  assert.equal(Number(requests[0].headers["content-length"]), requests[0].body.length);
  assert.equal(requests[0].headers["transfer-encoding"], undefined);
});

for (const effort of ["medium", undefined]) {
  test(`Chat Completions pins ${effort ?? "missing"} reasoning_effort`, async (t) => {
    const { url, requests } = await setup(t);
    const payload = { model: "gpt-6-astra", messages: [{ role: "user", content: "ping" }], reasoning_effort: effort };
    const response = await fetch(`${url}/openai/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(JSON.parse(requests[0].body), { ...payload, reasoning_effort: "high" });
  });
}

for (const path of ["responses", "chat/completions"]) {
  test(`${path} leaves other model names byte-for-byte unchanged`, async (t) => {
    const { url, requests } = await setup(t);
    for (const model of ["gpt-5.4", "gpt-6-astra-other", "GPT-6-ASTRA"]) {
      const body = `{ "model": "${model}", "reasoning": {"effort":"medium"}, "reasoning_effort": "low" }\n`;
      const response = await fetch(`${url}/openai/v1/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(requests.at(-1).body.toString(), body);
    }
  });
}

test("disabling Sticky High preserves the original body and effort", async (t) => {
  const { url, requests } = await setup(t, { env: { STICKY_HIGH_MODELS: "" } });
  const body = '{ "model": "gpt-6-astra", "reasoning": {"effort":"medium"} }';
  const response = await sendChunked(`${url}/openai/v1/responses`, Buffer.from(body));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(requests[0].body.toString(), body);
  assert.equal(JSON.parse(requests[0].body).reasoning.effort, "medium");
});

test("other routes and GET requests remain transparent", async (t) => {
  const { url, requests } = await setup(t);
  const body = "non-JSON upload content";
  const response = await fetch(`${url}/openai/v1/files`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(requests[0].body.toString(), body);
  const get = await fetch(`${url}/openai/v1/responses/response-id`);
  assert.equal(get.status, 200);
  await get.text();
  assert.equal(requests[1].body.length, 0);
});

for (const body of ["{bad", "null", "[]", '{"model":"gpt-6-astra","reasoning":"medium"}']) {
  test(`invalid JSON shape is rejected without calling upstream: ${body}`, async (t) => {
    const { url, requests } = await setup(t);
    const response = await fetch(`${url}/openai/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");
    assert.equal(requests.length, 0);
  });
}

for (const chunked of [false, true]) {
  test(`oversized ${chunked ? "chunked" : "fixed-length"} requests receive 413`, async (t) => {
    const { url, requests } = await setup(t, { env: { STICKY_HIGH_MAX_BODY_BYTES: "128" } });
    const body = Buffer.from(JSON.stringify({ model: "gpt-6-astra", input: "x".repeat(256) }));
    if (chunked) {
      const response = await sendChunked(`${url}/openai/v1/responses`, body);
      assert.equal(response.statusCode, 413);
      assert.match(response.body, /STICKY_HIGH_MAX_BODY_BYTES/);
    } else {
      const response = await fetch(`${url}/openai/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" }, body
      });
      assert.equal(response.status, 413);
      assert.match((await response.json()).message, /STICKY_HIGH_MAX_BODY_BYTES/);
    }
    assert.equal(requests.length, 0);
  });
}

for (const compressed of [false, true]) {
  test(`unsupported ${compressed ? "compressed" : "non-JSON"} inference requests are explicit errors`, async (t) => {
    const { url, requests } = await setup(t);
    const body = '{"model":"gpt-6-astra"}';
    const response = await fetch(`${url}/openai/v1/responses`, {
      method: "POST",
      headers: compressed ? { "content-type": "application/json", "content-encoding": "gzip" } : { "content-type": "text/plain" },
      body: compressed ? gzipSync(body) : body
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error, "invalid_request");
    assert.equal(requests.length, 0);
  });
}

test("upstream errors retain their status, headers and body", async (t) => {
  const { url, stream } = await setup(t, { statusCode: 429 });
  const response = await fetch(`${url}/openai/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"gpt-6-astra"}'
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-upstream"), "preserved");
  assert.equal(await response.text(), stream);
});
