import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
let since = "15 minutes ago", follow = false, json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) since = args[++i];
  else if (args[i] === "--follow") follow = true;
  else if (args[i] === "--json") json = true;
  else if (args[i] === "--help") {
    console.log('Usage: node scripts/usage-report.mjs [--since "15 minutes ago"] [--follow] [--json]');
    process.exit(0);
  } else { console.error(`Unknown option: ${args[i]}`); process.exit(1); }
}

const journal = spawn("journalctl", ["-u", "codexproxy.service", "--since", since, "-o", "cat", "--no-pager", ...(follow ? ["-f"] : [])], { stdio: ["ignore", "pipe", "inherit"] });
journal.on("error", error => { console.error(error.message); process.exitCode = 1; });
const exited = new Promise(resolve => journal.once("close", code => resolve(code ?? 1)));
const records = new Map();
const number = value => typeof value === "number" ? value : "?";
function row(record) {
  const usage = record.response?.usage;
  return {
    time: record.timestamp ?? record.started_at, id: record.request_id?.slice(0, 8),
    provider: record.provider ?? "?",
    model: record.request?.model ?? record.response?.model ?? "?", outcome: record.outcome,
    input: number(usage?.input_tokens), cached: number(usage?.cached_input_tokens),
    uncached: number(usage?.uncached_input_tokens), output: number(usage?.output_tokens),
    reasoning: number(usage?.reasoning_output_tokens), ms: record.duration_ms,
    remaining_tokens: record.response?.rate_limits?.["x-ratelimit-remaining-tokens"] ?? "?",
    limit_kind: record.response?.error?.limit_kind ?? ""
  };
}
for await (const line of createInterface({ input: journal.stdout })) {
  try {
    const record = JSON.parse(line);
    if (record.event !== "request.completed") continue;
    if (json) console.log(JSON.stringify(record));
    else if (follow) console.log(JSON.stringify(row(record)));
    else records.set(record.request_id, record);
  } catch { /* Skip unrelated service messages. */ }
}
if (!json && !follow) {
  const values = [...records.values()];
  console.log("Completed request usage. Times are UTC; minute totals are NOT Azure admission TPM.");
  console.table(values.slice(-30).map(row));
  const groups = new Map();
  for (const record of values) {
    const model = record.request?.model ?? record.response?.model ?? "?";
    const minute = (record.timestamp ?? record.started_at).slice(0, 16) + "Z";
    const provider = record.provider ?? "?";
    const key = `${minute}:${provider}:${model}`;
    const group = groups.get(key) ?? { minute, provider, model, requests: 0, not_completed: 0, missing_usage: 0, input: "?", cached: "?", output: "?", reasoning: "?" };
    group.requests++;
    if (record.outcome !== "completed") group.not_completed++;
    if (!record.usage_available) group.missing_usage++;
    for (const [column, field] of Object.entries({ input: "input_tokens", cached: "cached_input_tokens", output: "output_tokens", reasoning: "reasoning_output_tokens" })) {
      const value = record.response?.usage?.[field];
      group[column] = typeof value === "number" ? (typeof group[column] === "number" ? group[column] : 0) + value : group[column];
    }
    groups.set(key, group);
  }
  if (groups.size) console.table([...groups.values()]);
  else console.log("No completed request telemetry in this window.");
}
const code = await exited;
if (code !== 0) process.exitCode = code;
