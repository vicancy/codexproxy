import http from "node:http";
import { URL } from "node:url";
import { request as undiciRequest } from "undici";
import { CredentialUnavailableError } from "./auth.js";
import { createTelemetry } from "./telemetry.js";

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
  if (!config.stickyHighModels?.length || req.method !== "POST" ||
      !["/openai/v1/responses", "/openai/v1/chat/completions"].includes(pathname)) {
    const inspect = req.method === "POST" && ["/openai/v1/responses", "/openai/v1/chat/completions"].includes(pathname)
      && (req.headers["content-type"] ?? "application/json").includes("json")
      && (!req.headers["content-encoding"] || req.headers["content-encoding"] === "identity");
    return hasBody ? telemetry.observeRequest(req, inspect) : undefined;
  }

  const contentType = (req.headers["content-type"] ?? "application/json").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && !/^application\/[^\s/]+\+json$/.test(contentType)) {
    throw new RequestBodyError(415, "Sticky High requires a JSON inference request");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"].toLowerCase() !== "identity") {
    throw new RequestBodyError(415, "Sticky High does not support compressed inference requests");
  }

  const limit = config.stickyHighMaxBodyBytes;
  const tooLarge = () => new RequestBodyError(413, `Inference request exceeds STICKY_HIGH_MAX_BODY_BYTES (${limit})`);
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
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON inference request");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestBodyError(400, "Inference request must be a JSON object");
  }
  telemetry.requestPayload(payload, body.length);
  if (!config.stickyHighModels.includes(payload.model)) {
    return body;
  }

  if (pathname === "/openai/v1/responses") {
    if (payload.reasoning != null && (typeof payload.reasoning !== "object" || Array.isArray(payload.reasoning))) {
      throw new RequestBodyError(400, "reasoning must be a JSON object");
    }
    payload.reasoning = { ...payload.reasoning, effort: "high" };
  } else {
    payload.reasoning_effort = "high";
  }
  const rewritten = Buffer.from(JSON.stringify(payload));
  telemetry.forwardedPayload(payload, rewritten.length);
  return rewritten;
}

export function createProxyServer({ config, tokenManager, logger = console, requestImpl = undiciRequest }) {
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
        const readiness = tokenManager
          ? await tokenManager.checkReady()
          : await checkCopilotProxyReady(config, requestImpl, logger);
        writeJson(res, readiness.ok ? 200 : 503, readiness);
        return;
      }

      if (!req.url.startsWith("/openai/v1/")) {
        writeJson(res, 404, { error: "not_found", message: "Route not found" });
        return;
      }

      telemetry = createTelemetry(req, logger, { provider: config.upstreamProvider ?? "azure" });
      const upstreamUrl = getUpstreamUrl(req.url, config);
      const body = await prepareRequestBody(req, config, telemetry);
      const token = tokenManager
        ? await tokenManager.getAccessToken()
        : config.copilotProxyApiKey;
      const headers = normalizeUpstreamHeaders(req.headers, token);
      if (Buffer.isBuffer(body)) {
        headers["content-length"] = String(body.length);
      }
      const upstream = await requestImpl(upstreamUrl, {
        method: req.method,
        headers,
        body,
        headersTimeout: config.upstreamHeadersTimeoutMs,
        bodyTimeout: config.upstreamBodyTimeoutMs,
        signal: abort.signal
      });

      telemetry.headers(upstream.statusCode, upstream.headers);
      res.statusCode = upstream.statusCode;
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          telemetry.chunk(chunk);
          res.write(chunk);
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
        telemetry?.finish("request_error", error);
        req.resume();
        writeJson(res, error.statusCode, { error: "invalid_request", message: error.message });
        return;
      }

      if (error instanceof CredentialUnavailableError) {
        telemetry?.finish("authentication_error", error);
        writeJson(res, 503, {
          error: error.code,
          message: error.message
        });
        return;
      }

      telemetry?.finish("transport_error", error);
      writeJson(res, 502, {
        error: "proxy_error",
        message: errorMessage
      });
    }
  });
}
