/**
 * 把上游 SSE 拼成一次性 chat completion（非流式请求用）。
 *
 * 除了 content / tool_calls / usage，这里还保留 `reasoning_content`：
 * WorkBuddy 的部分模型会先输出整段推理，token 预算小时正文可能是空的
 * （finish_reason=length）。丢掉推理内容的话，客户端只会看到空回复。
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

export async function assembleFromChunks(chunks, fallbackModel) {
  let buffer = "";
  let id = null;
  let created = null;
  let model = fallbackModel;
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  const toolCalls = new Map();

  for await (const chunk of chunks) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (typeof event.id === "string") id = event.id;
      if (typeof event.created === "number") created = event.created;
      if (typeof event.model === "string") model = event.model;
      if (event.usage && typeof event.usage === "object") usage = event.usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      else if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = typeof call.index === "number" ? call.index : toolCalls.size;
          const existing = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
          if (typeof call.id === "string" && call.id !== "") existing.id = call.id;
          if (typeof call.type === "string" && call.type !== "") existing.type = call.type;
          if (call.function && typeof call.function === "object") {
            if (typeof call.function.name === "string" && call.function.name !== "") existing.function.name = call.function.name;
            if (typeof call.function.arguments === "string") existing.function.arguments += call.function.arguments;
          }
          toolCalls.set(index, existing);
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") finishReason = choice.finish_reason;
    }
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return {
    id: id ?? `chatcmpl-${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content === "" ? null : content,
        ...(reasoning === "" ? {} : { reasoning_content: reasoning }),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      },
      finish_reason: finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
    }],
    ...(usage === null ? {} : { usage }),
  };
}

export async function assembleCompletion(webBody, fallbackModel) {
  return assembleFromChunks(Readable.fromWeb(webBody), fallbackModel);
}
