/**
 * 统一的 system prompt 策略。
 *
 * 背景：WorkBuddy 国内版上游会按**精确短语/字节序列**拦截 agent harness 的 system prompt
 * （`400 … 11128 请求被拦截`）。历史实现是三处各自为战：
 *   - DSH：改第三方插件的 `index.js` + 内核（双空格展开 + 重试）；
 *   - Claude Code：桥接把 >800 字符的 system 整段换成中性提示词；
 *   - Hermes / Codex / OpenClaw：完全没保护。
 *
 * 现在收敛到桥接一处，两条协议（OpenAI / Anthropic）共用同一套实现：
 *   mode = "pass"    原样转发
 *   mode = "defang"  替换已知被拦句 + 代码块之外的双空格展开（字节序列改变，语义不变）
 *   mode = "neutral" 整段替换为中性提示词（仅在超过 neutralMinLength 时，避免破坏短提示词）
 *
 * 默认值：OpenAI 与 Anthropic 两个协议面都启用保护策略（defang / neutral），
 * 只有显式配置 `systemPolicy: "pass"` 才原样转发。
 * 显式配置 `systemPolicy` 对所有路径生效；`anthropicSystemMode` 是旧键，仍然优先于前者。
 */
import { sanitizeSystemText } from "./system-text.mjs";

export const SYSTEM_POLICIES = ["pass", "defang", "neutral"];

/** 被上游精确拦截的开场句（国内版实测）。 */
export const DEFAULT_BLOCKED_PHRASE = "You are an AI agent powered by DeepSeek Harness.";
export const DEFAULT_SAFE_PHRASE = "You are an AI agent running inside DeepSeek Harness.";

/** 中性系统提示词：保留"终端里的助手 + 会用工具"的最小语义。 */
export const NEUTRAL_SYSTEM_PROMPT = (
  "You are a helpful AI coding assistant running in a terminal CLI. "
  + "Follow the user instructions, be concise, and use the provided tools when they help complete the task. "
  + "Prefer reading files before editing and keep changes minimal."
);

const asString = (value, fallback) => (typeof value === "string" && value.trim() !== "" ? value : fallback);
const asPositiveInt = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);

/**
 * @param {object} config 桥接配置对象
 * @param {string} variantId `workbuddy` | `workbuddy-ai`
 * @param {"chat"|"anthropic"} surface 请求来源的协议面
 */
export function resolveSystemPolicy(config = {}, variantId = "workbuddy", surface = "chat") {
  const explicit = typeof config.systemPolicy === "string" ? config.systemPolicy.trim() : "";
  const legacy = typeof config.anthropicSystemMode === "string" ? config.anthropicSystemMode.trim() : "";

  let mode;
  if (surface === "anthropic" && SYSTEM_POLICIES.includes(legacy) ) {
    mode = legacy;
  } else if (surface === "anthropic" && legacy === "replace") {
    mode = "neutral";
  } else if (SYSTEM_POLICIES.includes(explicit)) {
    mode = explicit;
  } else if (surface === "anthropic") {
    mode = "neutral";
  } else {
    mode = "defang";
  }

  return {
    mode,
    surface,
    blocked: asString(config.systemBlockedPhrase, DEFAULT_BLOCKED_PHRASE),
    safe: asString(config.systemSafePhrase, DEFAULT_SAFE_PHRASE),
    neutral: asString(config.anthropicSystemPrompt, asString(config.neutralSystemPrompt, NEUTRAL_SYSTEM_PROMPT)),
    neutralMinLength: asPositiveInt(config.neutralMinLength, 800),
  };
}

/** 代码块之外的空格翻倍：Markdown 渲染与模型语义不变，但字节序列改变。 */
export function defangSpaces(text) {
  return String(text)
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/ /g, "  ")))
    .join("");
}

/** 对单个 system 文本应用策略。非字符串直接原样返回。 */
export function applySystemText(text, policy) {
  if (typeof text !== "string" || text === "") return text;
  if (policy === undefined || policy === null || policy.mode === "pass") return text;
  if (policy.mode === "neutral") {
    return text.length >= policy.neutralMinLength ? policy.neutral : text;
  }
  return defangSpaces(sanitizeSystemText(text.split(policy.blocked).join(policy.safe)));
}

/** 对 OpenAI messages 数组应用策略（只动 role === "system" 的字符串内容）。 */
export function applyMessages(messages, policy) {
  if (!Array.isArray(messages) || policy === undefined || policy === null || policy.mode === "pass") {
    return messages;
  }
  let changed = false;
  const out = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (message.role !== "system" || typeof message.content !== "string") return message;
    const next = applySystemText(message.content, policy);
    if (next === message.content) return message;
    changed = true;
    return { ...message, content: next };
  });
  return changed ? out : messages;
}

/**
 * 对**已序列化**的 OpenAI 请求体应用策略。
 * 解析失败时原样返回（让上游报出真实错误，而不是被策略层吞掉）。
 */
export function applyChatBody(rawJson, policy) {
  if (typeof rawJson !== "string" || policy === undefined || policy === null || policy.mode === "pass") {
    return rawJson;
  }
  let body;
  try {
    body = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  const messages = applyMessages(body?.messages, policy);
  if (messages === body?.messages) return rawJson;
  return JSON.stringify({ ...body, messages });
}
