import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

test("usage report filters inference, preserves missing usage, and retrieves correlated event chains",
  { skip: process.platform === "win32" }, async t => {
    const dir = await mkdtemp(join(tmpdir(), "codexproxy-report-test-"));
    t.after(() => rm(dir, { recursive: true }));
    const id = "12345678-1234-1234-1234-123456789012";
    const common = { started_at: "2026-10-19T03:00:00Z", request_id: id, provider: "github-copilot",
      transport: "direct", method: "POST", path: "/openai/v1/responses", request: { model: "gpt-6-astra" } };
    const records = [
      { ...common, event: "request.prepared" },
      { ...common, event: "upstream.request", attempt: 1 },
      { ...common, event: "request.completed", outcome: "completed", usage_available: true,
        response: { status_code: 200, usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10,
          reasoning_output_tokens: 5, total_tokens: 110 } } },
      { ...common, request_id: "87654321-1234-1234-1234-123456789012", event: "request.completed",
        outcome: "http_error", usage_available: false, response: { status_code: 400, usage: null } },
      { ...common, request_id: "99999999-1234-1234-1234-123456789012", event: "request.completed",
        method: "GET", path: "/openai/v1/models", outcome: "completed", usage_available: false,
        response: { status_code: 200, usage: null } }
    ];
    const data = join(dir, "journal.jsonl");
    await writeFile(data, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await writeFile(join(dir, "journalctl"), '#!/bin/sh\nexec cat "$TEST_JOURNAL"\n', { mode: 0o700 });
    const run = args => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/usage-report.mjs", import.meta.url)), ...args],
        { encoding: "utf8", env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, TEST_JOURNAL: data } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const full = run(["--json"]).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(full.length, 2);
    assert.equal(full[1].response.usage, null);
    const errors = run(["--errors", "--json"]).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].outcome, "http_error");
    const chain = run(["--request", "12345678"]).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(chain.map(record => record.event), ["request.prepared", "upstream.request", "request.completed"]);
    const table = run([]);
    assert.match(table, /missing_usage/);
    assert.match(table, /110/);
    assert.doesNotMatch(table, /99999999/);
  });
