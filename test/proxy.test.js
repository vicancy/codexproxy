import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxyServer } from "../src/proxy.js";

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve(address);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestAndCaptureClose(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      let aborted = false;

      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });

      res.on("aborted", () => {
        aborted = true;
      });

      res.on("error", reject);
      res.on("close", () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          aborted,
          complete: res.complete
        });
      });
    });

    req.on("error", reject);
  });
}

test("proxy forwards request with bearer token and strips api-key", async () => {
  let captured = null;

  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
      body
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  const upstreamAddr = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/openai/v1`,
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: {
      async getAccessToken() {
        return "token-from-proxy";
      },
      async checkReady() {
        return { ok: true };
      }
    },
    logger: { info() {}, error() {} }
  });

  const proxyAddr = await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer user-token",
      "api-key": "secret"
    },
    body: JSON.stringify({ model: "gpt-5.4", input: "ping" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(captured.url, "/openai/v1/responses");
  assert.equal(captured.authorization, "Bearer token-from-proxy");
  assert.equal(captured.apiKey, undefined);
  assert.match(captured.body, /\"model\":\"gpt-5.4\"/);

  await close(proxy);
  await close(upstream);
});

test("readiness endpoints return expected statuses", async () => {
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: "http://127.0.0.1:1/openai/v1",
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: {
      async getAccessToken() {
        return "token";
      },
      async checkReady() {
        return { ok: true, hasToken: true };
      }
    },
    logger: { info() {}, error() {} }
  });

  const proxyAddr = await listen(proxy);

  const health = await fetch(`http://127.0.0.1:${proxyAddr.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const ready = await fetch(`http://127.0.0.1:${proxyAddr.port}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, hasToken: true });

  const miss = await fetch(`http://127.0.0.1:${proxyAddr.port}/unknown`);
  assert.equal(miss.status, 404);

  await close(proxy);
});

test("streaming upstream failure after headers does not crash the proxy", async () => {
  const loggerErrors = [];

  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: "http://127.0.0.1:1/openai/v1",
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: {
      async getAccessToken() {
        return "token";
      },
      async checkReady() {
        return { ok: true };
      }
    },
    logger: {
      info() {},
      error(meta, message) {
        loggerErrors.push({ meta, message });
      }
    },
    async requestImpl() {
      return {
        statusCode: 200,
        headers: {
          "content-type": "text/plain"
        },
        body: (async function* () {
          yield "partial response";
          throw new Error("stream exploded");
        })()
      };
    }
  });

  const proxyAddr = await listen(proxy);

  const partial = await requestAndCaptureClose(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.body, "partial response");
  assert.equal(partial.complete, true);
  assert.equal(partial.aborted, false);

  const health = await fetch(`http://127.0.0.1:${proxyAddr.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  assert.equal(loggerErrors.length, 1);
  assert.equal(loggerErrors[0].meta.event, "request.completed");
  assert.equal(loggerErrors[0].meta.outcome, "transport_error");
  assert.equal(loggerErrors[0].meta.transport_error.type, "Error");
  assert.equal(loggerErrors[0].meta.usage_available, false);

  await close(proxy);
});

test("GitHub Copilot provider maps Codex routes to the Responses bridge and uses its local API key", async (t) => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.push({
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
      headers: req.headers,
      body: Buffer.concat(chunks).toString()
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamAddr = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer({
    config: {
      upstreamProvider: "github-copilot",
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/v1`,
      copilotProxyApiKey: "local-bridge-key",
      stickyHighModels: ["gpt-6-astra"],
      stickyHighMaxBodyBytes: 1024,
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: null,
    logger: { info(meta) { logs.push(meta); }, error(meta) { logs.push(meta); } }
  });
  const proxyAddr = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const ready = await fetch(`http://127.0.0.1:${proxyAddr.port}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, provider: "github-copilot", statusCode: 200 });

  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses?trace=1`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "client-token", "api-key": "client-key" },
    body: JSON.stringify({ model: "gpt-6-astra", input: "ping", reasoning: { effort: "medium" } })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.deepEqual(captured.map(({ url }) => url), ["/v1/models", "/v1/responses?trace=1"]);
  assert.deepEqual(captured.map(({ authorization, apiKey }) => ({ authorization, apiKey })), [
    { authorization: "Bearer local-bridge-key", apiKey: undefined },
    { authorization: "Bearer local-bridge-key", apiKey: undefined }
  ]);
  assert.equal(JSON.parse(captured[1].body).reasoning.effort, "high");
  assert.equal(Number(captured[1].headers["content-length"]), Buffer.byteLength(captured[1].body));
  const completed = logs.findLast(record => record.event === "request.completed");
  assert.equal(completed.provider, "github-copilot");
  assert.equal(completed.request.reasoning_effort, "high");
});

test("GitHub Copilot readiness reports an unavailable or unauthorized bridge", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  const upstreamAddr = await listen(upstream);
  const proxy = createProxyServer({
    config: {
      upstreamProvider: "github-copilot",
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/v1`,
      copilotProxyApiKey: "",
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: null,
    logger: { info() {}, error() {} }
  });
  const proxyAddr = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const ready = await fetch(`http://127.0.0.1:${proxyAddr.port}/readyz`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ok: false, provider: "github-copilot", statusCode: 401 });
});

test("GitHub Copilot readiness returns 503 when the bridge cannot be reached", async (t) => {
  const errors = [];
  const proxy = createProxyServer({
    config: {
      upstreamProvider: "github-copilot",
      upstreamBaseUrl: "http://127.0.0.1:1/v1",
      copilotProxyApiKey: "local-bridge-key",
      upstreamHeadersTimeoutMs: 100,
      upstreamBodyTimeoutMs: 100
    },
    tokenManager: null,
    logger: { info() {}, error(meta) { errors.push(meta); } }
  });
  const proxyAddr = await listen(proxy);
  t.after(() => close(proxy));

  const ready = await fetch(`http://127.0.0.1:${proxyAddr.port}/readyz`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ok: false, provider: "github-copilot", error: "upstream_unavailable" });
  assert.equal(errors[0].provider, "github-copilot");
});
