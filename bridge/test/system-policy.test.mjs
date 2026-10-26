import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BLOCKED_PHRASE,
  DEFAULT_SAFE_PHRASE,
  NEUTRAL_SYSTEM_PROMPT,
  applyChatBody,
  applyMessages,
  applySystemText,
  defangSpaces,
  resolveSystemPolicy,
} from "../lib/system-policy.mjs";

const policy = (overrides = {}) => ({
  mode: "defang",
  blocked: DEFAULT_BLOCKED_PHRASE,
  safe: DEFAULT_SAFE_PHRASE,
  neutral: NEUTRAL_SYSTEM_PROMPT,
  neutralMinLength: 800,
  ...overrides,
});

test("resolveSystemPolicy: 国内版 chat 默认 defang，国际版默认 pass", () => {
  assert.equal(resolveSystemPolicy({}, "workbuddy", "chat").mode, "defang");
  assert.equal(resolveSystemPolicy({}, "workbuddy-ai", "chat").mode, "pass");
});

test("resolveSystemPolicy: Anthropic 面默认沿用 neutral（旧的 replace 语义）", () => {
  assert.equal(resolveSystemPolicy({}, "workbuddy", "anthropic").mode, "neutral");
  // 旧键 replace 等价于 neutral
  assert.equal(resolveSystemPolicy({ anthropicSystemMode: "replace" }, "workbuddy", "anthropic").mode, "neutral");
  // 旧键 pass 仍然优先
  assert.equal(resolveSystemPolicy({ anthropicSystemMode: "pass" }, "workbuddy", "anthropic").mode, "pass");
});

test("resolveSystemPolicy: systemPolicy 显式值覆盖默认（两个协议面都生效）", () => {
  const config = { systemPolicy: "pass" };
  assert.equal(resolveSystemPolicy(config, "workbuddy", "chat").mode, "pass");
  assert.equal(resolveSystemPolicy(config, "workbuddy", "anthropic").mode, "pass");
});

test("resolveSystemPolicy: 非法值回落到默认，自定义短语被采用", () => {
  const resolved = resolveSystemPolicy({ systemPolicy: "nonsense", systemBlockedPhrase: "X", systemSafePhrase: "Y" }, "workbuddy", "chat");
  assert.equal(resolved.mode, "defang");
  assert.equal(resolved.blocked, "X");
  assert.equal(resolved.safe, "Y");
});

test("applySystemText: pass 原样返回", () => {
  const text = "You are an AI agent powered by DeepSeek Harness.";
  assert.equal(applySystemText(text, policy({ mode: "pass" })), text);
});

test("applySystemText: defang 替换被拦句并把空格翻倍", () => {
  const out = applySystemText("Hello World. You are an AI agent powered by DeepSeek Harness.", policy());
  assert.equal(out.includes(DEFAULT_BLOCKED_PHRASE), false);
  assert.equal(out.includes("DeepSeek  Harness."), true); // 空格已翻倍
  assert.equal(out.startsWith("Hello  World."), true);
});

test("defangSpaces: 代码块内部不改写", () => {
  const code = "```js\nconst answer = 42;\n```";
  const out = defangSpaces(`before code ${code} after code`);
  assert.equal(out.includes(code), true);
  assert.equal(out.includes("before  code"), true);
});

test("applySystemText: 剥掉 x-anthropic-billing-header 行", () => {
  const out = applySystemText("x-anthropic-billing-header: cc_version=1.0\nreal prompt", policy({ mode: "defang" }));
  assert.equal(out.includes("x-anthropic-billing-header"), false);
  assert.equal(out.includes("real  prompt"), true);
});

test("applySystemText: neutral 只对超过阈值的提示词生效", () => {
  const short = "short prompt";
  assert.equal(applySystemText(short, policy({ mode: "neutral", neutralMinLength: 100 })), short);
  const long = "x".repeat(200);
  assert.equal(applySystemText(long, policy({ mode: "neutral", neutralMinLength: 100 })), NEUTRAL_SYSTEM_PROMPT);
});

test("applyMessages: 只改 system，且无变化时返回原引用", () => {
  const messages = [
    { role: "system", content: DEFAULT_BLOCKED_PHRASE },
    { role: "user", content: DEFAULT_BLOCKED_PHRASE },
  ];
  const changed = applyMessages(messages, policy());
  assert.notEqual(changed, messages);
  assert.equal(changed[0].content.includes(DEFAULT_BLOCKED_PHRASE), false);
  assert.equal(changed[1], messages[1]); // 非 system 不动

  const passthrough = [{ role: "user", content: "hi" }];
  assert.equal(applyMessages(passthrough, policy()), passthrough);
});

test("applyMessages: pass 模式不动数组", () => {
  const messages = [{ role: "system", content: DEFAULT_BLOCKED_PHRASE }];
  assert.equal(applyMessages(messages, policy({ mode: "pass" })), messages);
});

test("applyChatBody: 保留非 messages 字段，非法 JSON 原样返回", () => {
  const raw = JSON.stringify({ model: "m", temperature: 0.2, messages: [{ role: "system", content: DEFAULT_BLOCKED_PHRASE }] });
  const out = JSON.parse(applyChatBody(raw, policy()));
  assert.equal(out.model, "m");
  assert.equal(out.temperature, 0.2);
  assert.equal(out.messages[0].content.includes(DEFAULT_BLOCKED_PHRASE), false);

  assert.equal(applyChatBody("not json", policy()), "not json");
});
