import http from "node:http";
import { URL } from "node:url";
import { request as undiciRequest } from "undici";
import { CredentialUnavailableError } from "./auth.js";
import { normalizeResponseMessageIds } from "./response-stream.js";
import { createTelemetry } from "./telemetry.js";
import { adaptCopilotResponses } from "./copilot.js";
import { once } from "node:events";

function normalizeUpstreamHeaders(incomingHeaders, token) {
  const headers = { ...incomingHeaders };
  delete headers.host;
  delete headers.authorization;
  delete headers["api-key"];
  // Undici determines framing for both streamed and rewritten bodies.
  delete headers["transfer-encoding"];
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function getUpstreamUrl(requestUrl, config) {
  const path = config.upstreamProvider === "github-copilot"
    ? requestUrl.replace(/^\/openai(?=\/v1\/)/, "")
    : requestUrl;
  return new URL(path, `${config.upstreamBaseUrl}/`);
}

async function checkCopilotProxyReady(config, requestImpl, logger) {
  try {
    const headers = config.copilotProxyApiKey
      ? { authorization: `Bearer ${config.copilotProxyApiKey}` }
      : {};
    const upstream = await requestImpl(new URL("models", `${config.upstreamBaseUrl}/`), {
      method: "GET",
      headers,
      headersTimeout: config.upstreamHeadersTimeoutMs,
      bodyTimeout: config.upstreamBodyTimeoutMs
    });
    if (upstream.body?.dump) {
      await upstream.body.dump();
    } else if (upstream.body) {
      for await (const _ of upstream.body) { /* discard model catalog */ }
    }
    return {
      ok: upstream.statusCode >= 200 && upstream.statusCode < 300,
      provider: "github-copilot",
      statusCode: upstream.statusCode
    };
  } catch (error) {
    logger.error?.({
      provider: "github-copilot",
      error: error instanceof Error ? error.name : "UnknownError"
    }, "GitHub Copilot bridge readiness check failed");
    return { ok: false, provider: "github-copilot", error: "upstream_unavailable" };
  }
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

class RequestBodyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function prepareRequestBody(req, config, telemetry) {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const pathname = req.url.split("?")[0].replace(/\/$/, "");
  const native = config.upstreamProvider === "github-copilot" && config.copilotTransport === "direct";
  if ((!config.stickyHighModels?.length && !native) || req.method !== "POST" ||
      !["/openai/v1/responses", "/openai/v1/chat/completions"].includes(pathname)) {
    const inspect = req.method === "POST" && ["/openai/v1/responses", "/openai/v1/chat/completions"].includes(pathname)
      && (req.headers["content-type"] ?? "application/json").includes("json")
      && (!req.headers["content-encoding"] || req.headers["content-encoding"] === "identity");
    return hasBody ? telemetry.observeRequest(req, inspect) : undefined;
  }

  const contentType = (req.headers["content-type"] ?? "application/json").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && !/^application\/[^\s/]+\+json$/.test(contentType)) {
    throw new RequestBodyError(415, "Request adaptation requires a JSON inference request");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"].toLowerCase() !== "identity") {
    throw new RequestBodyError(415, "Request adaptation does not support compressed inference requests");
  }

  const limit = native ? Math.min(config.stickyHighMaxBodyBytes ?? 32 * 1024 * 1024, 5_000_000)
    : config.stickyHighMaxBodyBytes;
  const tooLarge = () => new RequestBodyError(413, `Inference request exceeds ${native ? "Copilot payload limit" : "STICKY_HIGH_MAX_BODY_BYTES"} (${limit})`);
  if (Number(req.headers["content-length"]) > limit) {
    throw tooLarge();
  }

  const chunks = [];
  let length = 0;
  // Keep the socket open so validation errors can be sent back to the client.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, length);
  telemetry.requestBody(body);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON inference request");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestBodyError(400, "Inference request must be a JSON object");
  }
  telemetry.requestPayload(payload, body.length, body);
  const changes = [];
  const sticky = config.stickyHighModels?.includes(payload.model);
  if (sticky && pathname === "/openai/v1/responses") {
    if (payload.reasoning != null && (typeof payload.reasoning !== "object" || Array.isArray(payload.reasoning))) {
      throw new RequestBodyError(400, "reasoning must be a JSON object");
    }
    payload.reasoning = { ...payload.reasoning, effort: "high" };
    changes.push({ action: "sticky_high", path: "reasoning.effort" });
  } else if (sticky) {
    payload.reasoning_effort = "high";
    changes.push({ action: "sticky_high", path: "reasoning_effort" });
  }
  if (native && pathname === "/openai/v1/responses") {
    const adapted = adaptCopilotResponses(payload);
    payload = adapted.payload;
    changes.push(...adapted.changes);
  }
  const rewritten = sticky || changes.length ? Buffer.from(JSON.stringify(payload)) : body;
  telemetry.forwardedPayload(payload, rewritten.length, rewritten);
  if (native && rewritten.length > limit) throw tooLarge();
  telemetry.prepared(changes);
  return rewritten;
}

export function createProxyServer({ config, tokenManager, copilotClient, logger = console, requestImpl = undiciRequest }) {
  if (config.upstreamProvider === "github-copilot" && config.copilotTransport === "direct" && !copilotClient) {
    throw new Error("Native Copilot configuration requires a native Copilot client");
  }
  return http.createServer(async (req, res) => {
    let telemetry;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) { telemetry?.finish("client_disconnected"); abort.abort(); }
    });
    req.on("aborted", () => abort.abort());
    try {
      if (!req.url) {
        writeJson(res, 400, { error: "bad_request", message: "Missing request URL" });
        return;
      }

      if (req.url === "/healthz") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.url === "/readyz") {
        let readiness;
        try {
          readiness = copilotClient ? await copilotClient.checkReady() : tokenManager
            ? await tokenManager.checkReady() : await checkCopilotProxyReady(config, requestImpl, logger);
        } catch (error) {
          logger.error?.({ event: "readiness.failed", provider: config.upstreamProvider,
            transport: config.copilotTransport, error: error.name }, "readiness.failed");
          readiness = { ok: false, provider: config.upstreamProvider,
            error: error instanceof CredentialUnavailableError ? error.code : "upstream_unavailable" };
        }
        writeJson(res, readiness.ok ? 200 : 503, readiness);
        return;
      }

      if (!req.url.startsWith("/openai/v1/")) {
        writeJson(res, 404, { error: "not_found", message: "Route not found" });
        return;
      }

      telemetry = createTelemetry(req, logger, { provider: config.upstreamProvider ?? "azure",
        ...(config.upstreamProvider === "github-copilot" ? { transport: config.copilotTransport ?? "bridge" } : {}) });
      res.setHeader("x-codexproxy-request-id", telemetry.requestId);
      if (copilotClient && !["/openai/v1/responses", "/openai/v1/models"].includes(req.url.split("?")[0])) {
        throw new RequestBodyError(501, "Native Copilot supports /responses and /models only");
      }
      if (copilotClient && req.method !== (req.url.split("?")[0] === "/openai/v1/models" ? "GET" : "POST")) {
        throw new RequestBodyError(405, "Method not supported for this native Copilot endpoint");
      }
      const upstreamUrl = getUpstreamUrl(req.url, config);
      const body = await prepareRequestBody(req, config, telemetry);
      telemetry.stage("authentication");
      const token = tokenManager
        ? await tokenManager.getAccessToken()
        : config.copilotProxyApiKey;
      const headers = normalizeUpstreamHeaders(req.headers, token);
      if (Buffer.isBuffer(body)) {
        headers["content-length"] = String(body.length);
      }
      const options = {
        method: req.method,
        headers,
        body,
        headersTimeout: config.upstreamHeadersTimeoutMs,
        bodyTimeout: config.upstreamBodyTimeoutMs,
        signal: abort.signal
      };
      let upstream;
      if (copilotClient) {
        const payload = Buffer.isBuffer(body) ? JSON.parse(body.toString("utf8")) : null;
        upstream = await copilotClient.request(req.url, { ...options,
          stream: payload?.stream === true,
          hasImages: Array.isArray(payload?.input) && payload.input.some(item =>
            Array.isArray(item?.content) && item.content.some(part => part?.type === "input_image"))
        }, telemetry);
      } else {
        telemetry.stage("upstream_headers");
        upstream = await requestImpl(upstreamUrl, options);
      }

      telemetry.stage("response_stream");
      telemetry.headers(upstream.statusCode, upstream.headers);
      const normalizeMessages = req.url.split("?")[0] === "/openai/v1/responses"
        && /^text\/event-stream\b/i.test(upstream.headers["content-type"] ?? "")
        && [undefined, "identity"].includes(upstream.headers["content-encoding"]);
      res.statusCode = upstream.statusCode;
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && key.toLowerCase() !== "x-codexproxy-request-id"
            && !(normalizeMessages && key.toLowerCase() === "content-length")) {
          res.setHeader(key, value);
        }
      }

      if (upstream.body) {
        const body = normalizeMessages ? normalizeResponseMessageIds(upstream.body) : upstream.body;
        for await (const chunk of body) {
          telemetry.chunk(chunk);
          if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
        }
      }
      res.end();

      telemetry.finish();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (res.headersSent || res.writableEnded) {
        telemetry?.finish("transport_error", error);

        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }

      if (error instanceof RequestBodyError) {
        telemetry?.localStatus(error.statusCode);
        telemetry?.finish("request_error", error);
        req.resume();
        writeJson(res, error.statusCode, { error: "invalid_request", message: error.message });
        return;
      }

      if (error instanceof CredentialUnavailableError) {
        telemetry?.localStatus(503);
        telemetry?.finish("authentication_error", error);
        writeJson(res, 503, {
          error: error.code,
          message: error.message
        });
        return;
      }

      telemetry?.localStatus(502);
      telemetry?.finish("transport_error", error);
      writeJson(res, 502, {
        error: "proxy_error",
        message: errorMessage
      });
    }
  });
}
