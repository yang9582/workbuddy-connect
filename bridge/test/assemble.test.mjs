import assert from "node:assert/strict";
import test from "node:test";

import { assembleFromChunks } from "../lib/assemble.mjs";
import { hasImageParts } from "../lib/content.mjs";

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`);

test("assemble: content, usage and finish_reason", async () => {
  const chunks = sse([
    { id: "x", model: "m", choices: [{ delta: { content: "你" } }] },
    { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 3, completion_tokens: 2 } },
    { choices: [] },
  ]);
  const completion = await assembleFromChunks(chunks, "fallback");
  assert.equal(completion.model, "m");
  assert.equal(completion.choices[0].message.content, "你好");
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.deepEqual(completion.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test("assemble: reasoning_content survives the non-streaming path", async () => {
  const chunks = sse([
    { choices: [{ delta: { reasoning_content: "先想" } }] },
    { choices: [{ delta: { reasoning_content: "再答" } }] },
    { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
  ]);
  const completion = await assembleFromChunks(chunks, "m");
  assert.equal(completion.choices[0].message.reasoning_content, "先想再答");
  assert.equal(completion.choices[0].message.content, "ok");
});

test("assemble: empty content stays null but reasoning is kept", async () => {
  const chunks = sse([
    { choices: [{ delta: { reasoning_content: "only thinking" }, finish_reason: "length" }] },
  ]);
  const completion = await assembleFromChunks(chunks, "m");
  assert.equal(completion.choices[0].message.content, null);
  assert.equal(completion.choices[0].message.reasoning_content, "only thinking");
  assert.equal(completion.choices[0].finish_reason, "length");
});

test("assemble: tool call deltas accumulate by index", async () => {
  const chunks = sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a\"}" } }] }, finish_reason: "tool_calls" }] },
  ]);
  const completion = await assembleFromChunks(chunks, "m");
  const [call] = completion.choices[0].message.tool_calls;
  assert.equal(call.id, "t1");
  assert.equal(call.function.name, "read");
  assert.equal(call.function.arguments, "{\"path\":\"a\"}");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
});

test("assemble: tolerates Buffer chunks and malformed lines", async () => {
  const chunks = [
    Buffer.from("data: not-json\n\n"),
    Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`),
    "data: [DONE]\n\n",
  ];
  const completion = await assembleFromChunks(chunks, "m");
  assert.equal(completion.choices[0].message.content, "x");
});

test("hasImageParts: detects all three content block shapes", () => {
  assert.equal(hasImageParts([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
  assert.equal(hasImageParts([{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }]), true);
  assert.equal(hasImageParts([{ role: "user", content: [{ type: "image", source: {} }] }]), true);
  assert.equal(hasImageParts([{ role: "user", content: [{ type: "input_image" }] }]), true);
  assert.equal(hasImageParts([{ role: "user", content: "plain" }]), false);
  assert.equal(hasImageParts(undefined), false);
});
