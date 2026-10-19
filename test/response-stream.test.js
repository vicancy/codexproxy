import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResponseMessageIds } from "../src/response-stream.js";

async function* chunks(text, size = 7) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect(body) {
  let text = "";
  for await (const chunk of body) text += chunk;
  return text;
}

function parse(text) {
  return text.split(/\r\n|\r|\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}

test("changing message IDs stay consistent across deltas, done and terminal output", async () => {
  const message = (id, text) => ({ id, type: "message", role: "assistant", phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }] });
  const reasoning = { id: "reasoning-original", type: "reasoning", encrypted_content: "opaque" };
  const tool = { id: "tool-original", type: "function_call", call_id: "call-original", name: "test", arguments: "{}" };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: message("first-message", "") },
    { type: "response.output_item.added", output_index: 2, item: tool },
    { type: "response.output_item.added", output_index: 3, item: message("second-message", "") },
    { type: "response.content_part.added", output_index: 1, item_id: "part-id", content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", output_index: 3, item_id: "delta-second", content_index: 0, delta: "第二条" },
    { type: "response.output_text.delta", output_index: 1, item_id: "delta-first", content_index: 0, delta: "中文\n回复" },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "tool-delta-id", delta: "{}" },
    { type: "response.output_text.done", output_index: 1, item_id: "text-done", content_index: 0, text: "中文\n回复" },
    { type: "response.content_part.done", output_index: 1, item_id: "part-done", content_index: 0, part: { type: "output_text", text: "中文\n回复" } },
    { type: "response.output_item.done", output_index: 1, item: message("done-first", "中文\n回复") },
    { type: "response.output_item.done", output_index: 3, item: message("done-second", "第二条") },
    { type: "response.completed", response: { output: [reasoning, message("terminal-first", "中文\n回复"), tool, message("terminal-second", "第二条")] } }
  ];
  const expected = structuredClone(events);
  for (const event of expected) {
    const id = event.output_index === 1 ? "first-message" : event.output_index === 3 ? "second-message" : null;
    if (id && event.item) event.item.id = id;
    if (id && event.item_id) event.item_id = id;
  }
  expected.at(-1).response.output[1].id = "first-message";
  expected.at(-1).response.output[3].id = "second-message";

  for (const newline of ["\n", "\r\n", "\r"]) {
    const raw = events.map((event, index) => `: keepalive${newline}id: ${index}${newline}event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join("");
    const actual = await collect(normalizeResponseMessageIds(chunks(raw, 1)));
    assert.deepEqual(parse(actual), expected);
    assert.equal(actual.split(": keepalive").length, events.length + 1);
    assert.equal(actual.split(`${newline}id: `).length, events.length + 1);
  }
});

test("stable IDs, unrelated events, errors and incomplete frames pass through unchanged", async () => {
  const raw = ': comment\r\nevent: response.output_item.added\r\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"stable","type":"message"}}\r\n\r\n'
    + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"stable","delta":"hi"}\r\n\r\n'
    + 'data: {"type":"error","message":"upstream error"}\r\n\r\n'
    + 'data: null\r\n\r\ndata: not-json\r\n\r\ndata: [DONE]\r\n\r\ndata: {"unfinished":';
  assert.equal(await collect(normalizeResponseMessageIds(chunks(raw, 1))), raw);
});

test("normalization streams each event immediately and propagates upstream failure", async () => {
  let resumed = false;
  const body = (async function* () {
    yield 'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"first","type":"message"}}\n\n';
    resumed = true;
    throw new Error("upstream disconnected");
  })();
  const stream = normalizeResponseMessageIds(body);
  assert.equal((await stream.next()).done, false);
  assert.equal(resumed, false);
  await assert.rejects(stream.next(), /upstream disconnected/);
});
