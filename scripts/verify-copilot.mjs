import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { CopilotTokenManager } from "../src/copilot-auth.js";
import { createCopilotClient } from "../src/copilot.js";
import { createProxyServer } from "../src/proxy.js";

const records = [];
const logger = { info(record) { records.push(structuredClone(record)); }, error(record) { records.push(structuredClone(record)); } };
const config = loadConfig({ ...process.env, UPSTREAM_PROVIDER: "github-copilot", COPILOT_TRANSPORT: "direct" });
const client = createCopilotClient({ config, tokenManager: new CopilotTokenManager({ tokenFile: config.copilotTokenFile, logger }) });
const proxy = createProxyServer({ config, copilotClient: client, logger });
await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
const model = process.env.COPILOT_VERIFY_MODEL || "gpt-6-astra";

async function generate(payload) {
  const response = await fetch(`${base}/openai/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, max_output_tokens: 1024, reasoning: { effort: "high", summary: "auto" }, ...payload })
  });
  const text = await response.text();
  const id = response.headers.get("x-codexproxy-request-id");
  const record = records.findLast(item => item.event === "request.completed" && item.request_id === id);
  console.log(JSON.stringify({ request_id: id, status: response.status, outcome: record?.outcome,
    usage: record?.response.usage, error: record?.response.error, diagnostics: record?.request_diagnostics }));
  assert.equal(response.status, 200, "Copilot generation failed; inspect the correlated error code above");
  assert.ok(record?.usage_available, "Actual upstream usage must be captured");
  assert.equal(record.outcome, "completed");
  return { text, record };
}

try {
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200, "Copilot token and model catalog must be available");
  const modelsResponse = await fetch(`${base}/openai/v1/models`);
  const models = await modelsResponse.json();
  assert.ok(models.data?.some(item => item.id === model), "Verification model must appear in Copilot catalog");
  for (const type of ["function", "custom"]) {
    const tool = type === "function"
      ? { type, name: "diagnostic_echo", description: "Echo ping for a connection check.",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, strict: true }
      : { type, name: "diagnostic_echo", description: "Echo ping for a connection check.", format: { type: "text" } };
    const input = [{ role: "user", content: "Call diagnostic_echo with ping exactly once. After receiving its result, reply OK." }];
    const first = await generate({ input, tools: [tool], tool_choice: { type, name: tool.name },
      include: ["reasoning.encrypted_content"], store: false });
    const result = JSON.parse(first.text);
    const call = result.output?.find(item => item.type === (type === "function" ? "function_call" : "custom_tool_call"));
    assert.ok(call?.call_id, `Copilot must produce a ${type} tool call`);
    const second = await generate({
      input: [...input, ...result.output, { type: type === "function" ? "function_call_output" : "custom_tool_call_output",
        call_id: call.call_id, output: "ping" }],
      tools: [tool], stream: true, store: false, include: ["reasoning.encrypted_content"]
    });
    assert.match(second.text, /response\.completed/);
    assert.equal(second.record.request_diagnostics.issue_count, 0);
    assert.equal(second.record.response.event_counts["response.completed"], 1);
    console.log(`${type} tool round trip and streamed usage verified.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await new Promise(resolve => proxy.close(resolve));
}
