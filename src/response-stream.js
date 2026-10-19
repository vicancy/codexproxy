import { StringDecoder } from "node:string_decoder";

// Some upstreams return a different ID for the same message on every SSE event.
// Keep the first ID for each output slot so clients can reconcile deltas with
// the completed message. Preserve upstream IDs for subsequent conversation input.
export async function* normalizeResponseMessageIds(body) {
  const decoder = new StringDecoder("utf8");
  const messageIds = new Map();
  let pending = "";

  function rewrite(frame) {
    const lines = frame.split(/\r\n|\r|\n/);
    const data = lines.filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    let event;
    try { event = JSON.parse(data); } catch { return frame; }
    if (!event || typeof event !== "object") return frame;

    let changed = false;
    const setId = (object, key, id) => {
      if (typeof object?.[key] === "string" && object[key] !== id) {
        object[key] = id;
        changed = true;
      }
    };
    const index = event.output_index;
    if (Number.isInteger(index) && index >= 0) {
      if (["response.output_item.added", "response.output_item.done"].includes(event.type)
          && event.item?.type === "message" && typeof event.item.id === "string") {
        if (!messageIds.has(index)) messageIds.set(index, event.item.id);
        setId(event.item, "id", messageIds.get(index));
      }
      if (typeof event.type === "string" && event.type.startsWith("response.") && messageIds.has(index)) {
        setId(event, "item_id", messageIds.get(index));
      }
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)
        && Array.isArray(event.response?.output)) {
      event.response.output.forEach((item, outputIndex) => {
        if (item?.type === "message" && messageIds.has(outputIndex)) {
          setId(item, "id", messageIds.get(outputIndex));
        }
      });
    }
    if (!changed) return frame;

    // Retain comments and event/id/retry fields; multiline data becomes one line.
    const newline = frame.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    let written = false;
    return lines.flatMap(line => {
      if (!line.startsWith("data:")) return [line];
      if (written) return [];
      written = true;
      return [`data: ${JSON.stringify(event)}`];
    }).join(newline);
  }

  for await (const chunk of body) {
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      yield rewrite(pending.slice(0, boundary.index)) + boundary[0];
      pending = pending.slice(boundary.index + boundary[0].length);
    }
  }
  pending += decoder.end();
  // Do not turn a truncated event into a completed SSE event.
  if (pending) yield pending;
}
