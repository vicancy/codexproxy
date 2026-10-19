const callTypes = new Set(["function_call", "custom_tool_call"]);
const outputTypes = new Set(["function_call_output", "custom_tool_call_output"]);
const MAX_ISSUES = 20;

export function inspectRequest(payload) {
  const issues = [];
  let totalIssues = 0;
  const add = (code, path) => {
    totalIssues++;
    if (issues.length < MAX_ISSUES) issues.push({ code, path });
  };
  const input = Array.isArray(payload.input) ? payload.input : [];
  const calls = new Map();
  const outputs = new Set();
  let encryptedReasoning = 0, embeddedTools = 0;
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      add("invalid_input_item", `input[${index}]`);
      continue;
    }
    if (item.type === "reasoning" && typeof item.encrypted_content === "string") encryptedReasoning++;
    if (item.type === "additional_tools" && Array.isArray(item.tools)) embeddedTools += item.tools.length;
    if (callTypes.has(item.type)) {
      if (typeof item.call_id !== "string" || !item.call_id) add("missing_call_id", `input[${index}].call_id`);
      else {
        if (calls.has(item.call_id)) add("duplicate_tool_call", `input[${index}].call_id`);
        calls.set(item.call_id, item.type);
      }
      const value = item.type === "function_call" ? item.arguments : item.input;
      if (typeof value !== "string") add("invalid_tool_input_type", `input[${index}]`);
      else if (item.type === "function_call" && item.status !== "in_progress") {
        try { JSON.parse(value); } catch { add("invalid_function_arguments_json", `input[${index}].arguments`); }
      }
    }
    if (outputTypes.has(item.type)) {
      if (typeof item.call_id !== "string" || !item.call_id) add("missing_call_id", `input[${index}].call_id`);
      else {
        if (outputs.has(item.call_id)) add("duplicate_tool_output", `input[${index}].call_id`);
        outputs.add(item.call_id);
        if (!payload.previous_response_id && !calls.has(item.call_id)) add("orphan_tool_output", `input[${index}].call_id`);
        const expected = item.type === "function_call_output" ? "function_call" : "custom_tool_call";
        if (calls.has(item.call_id) && calls.get(item.call_id) !== expected) add("tool_call_type_mismatch", `input[${index}]`);
      }
    }
  }
  return { issues, issue_count: totalIssues, issues_truncated: totalIssues > issues.length,
    encrypted_reasoning_items: encryptedReasoning, embedded_tool_count: embeddedTools };
}
