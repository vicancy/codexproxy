import { randomUUID } from "node:crypto";
import { request as undiciRequest } from "undici";
import { copilotClientHeaders } from "./copilot-auth.js";

export function adaptCopilotResponses(payload) {
  const changes = [];
  let result = { ...payload };
  const omit = field => {
    if (Object.hasOwn(result, field)) {
      delete result[field];
      changes.push({ action: "omit_unsupported_parameter", path: field });
    }
  };
  omit("service_tier");
  if (result.model === "gpt-6-astra") {
    for (const field of ["temperature", "top_p", "top_logprobs", "logprobs"]) omit(field);
    if (Array.isArray(result.include) && result.include.includes("message.output_text.logprobs")) {
      result.include = result.include.filter(value => value !== "message.output_text.logprobs");
      changes.push({ action: "omit_unsupported_parameter", path: "include.logprobs" });
    }
  }
  // Preserve history, tool arguments and encrypted reasoning verbatim. A generic
  // 400 is not sufficient evidence to delete context or replay a paid request.
  return { payload: result, changes };
}

export function createCopilotClient({ config, tokenManager, requestImpl = undiciRequest }) {
  const baseUrl = config.copilotAccountType === "individual" ? "https://api.githubcopilot.com"
    : `https://api.${config.copilotAccountType}.githubcopilot.com`;

  async function request(path, options, telemetry) {
    const pathname = new URL(path, "http://localhost").pathname;
    const suffix = path.replace(/^\/openai\/v1/, "");
    const url = new URL(`${baseUrl}${suffix}`);
    telemetry?.stage("authentication");
    let token = await tokenManager.getAccessToken();
    for (let attempt = 1; attempt <= 2; attempt++) {
      telemetry?.stage("upstream_headers");
      const upstreamRequestId = randomUUID();
      const headers = {
        ...copilotClientHeaders,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: options.stream ? "text/event-stream" : "application/json",
        "accept-encoding": "identity",
        "copilot-integration-id": "vscode-chat",
        "openai-intent": "conversation-panel",
        "x-vscode-user-agent-library-version": "electron-fetch",
        "x-request-id": upstreamRequestId,
        ...(options.method === "POST" ? { "x-initiator": "agent" } : {}),
        ...(options.hasImages ? { "copilot-vision-request": "true" } : {})
      };
      telemetry?.event("upstream.request", { attempt, upstream_request_id: upstreamRequestId,
        endpoint: pathname.replace(/^\/openai\/v1/, ""), auth_retry: attempt > 1 });
      const upstream = await requestImpl(url, {
        method: options.method, body: options.body, headers,
        headersTimeout: config.upstreamHeadersTimeoutMs,
        bodyTimeout: config.upstreamBodyTimeoutMs, signal: options.signal
      });
      telemetry?.event("upstream.response", { attempt, status_code: upstream.statusCode,
        upstream_request_id: upstreamRequestId,
        upstream_response_id: safeRequestId(upstream.headers["x-request-id"]) });
      if (attempt === 1 && [401, 403].includes(upstream.statusCode)) {
        // Only replay explicit auth rejections, never ambiguous transport errors,
        // rate limits or a response whose stream has started.
        await upstream.body.dump();
        telemetry?.stage("authentication");
        token = await tokenManager.getAccessToken({ staleToken: token });
        continue;
      }
      return upstream;
    }
  }

  async function checkReady() {
    const upstream = await request("/openai/v1/models", { method: "GET" });
    await upstream.body.dump();
    return { ok: upstream.statusCode === 200, provider: "github-copilot", transport: "direct",
      statusCode: upstream.statusCode };
  }
  return { request, checkReady, baseUrl };
}

function safeRequestId(value) {
  return typeof value === "string" && /^[\w.:-]{1,160}$/.test(value) ? value : null;
}
