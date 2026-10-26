#!/usr/bin/env node
/**
 * workbuddy-bridge —— 把 WorkBuddy 桌面 App 的模型接入 Hermes Agent。
 *
 * 原理（全部复用 dsh-workbuddy-connect（MIT）的宿主内核，见 vendor/host-bundle.js）：
 *   - 凭据：读取 WorkBuddy 桌面 App 的登录态（5.6+ 为加密凭据，经 App 自带
 *     Electron 解密），access token 临近过期时自动刷新；
 *   - 上游：WorkBuddyUpstreamClient，请求 copilot.tencent.com（国内版）/
 *     workbuddy.ai（国际版）的 /v2/chat/completions；
 *   - 出口：本进程在 127.0.0.1 上暴露 OpenAI 兼容接口
 *     （GET /healthz、GET /v1/models、POST /v1/chat/completions，
 *      支持 SSE 流式与工具调用），Hermes 以“自定义 provider”接入。
 *
 * 注意：个人自用；依赖 WorkBuddy 非公开客户端接口，App 大版本更新后可能失效。
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

// 内核只通过 lib/kernel.mjs 加载：那里集中处理打包产物的单字母别名，
// 并在上游布局变化时抛出可读的 KernelContractError（而不是 import 期 SyntaxError）。
import {
  WorkBuddyUpstreamClient,      // 上游客户端：chatStream / refreshToken / fetchModels / fetchCredits
  WorkBuddyCredentialStore,     // 凭据存储：桌面登录态 + 自动刷新
  atRestKeyProviderFor,         // 加密凭据的密钥提供者（调用 App 自带 Electron 解密）
  CN_VARIANT,                   // 国内版 WorkBuddy
  AI_VARIANT,                   // 国际版 WorkBuddy AI
  variantFor,
  prepareChatBody,              // OpenAI 请求体规范化（强制 stream / developer→system / tool_choice 扁平化）
  modelWithCurrentPromotion,    // 叠加“当前生效”的促销 → 实时倍率 + 促销徽章（同 DSH 展示）
  normalizeCredits,             // 上游 credits 串 → 纯倍率（x0.79）
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_AI_MODELS,
  describeKernel,
} from "./lib/kernel.mjs";
import { applyChatBody, applyMessages, resolveSystemPolicy } from "./lib/system-policy.mjs";
import { sanitizeSystemText } from "./lib/system-text.mjs";
import { loadDshEnv } from "./lib/dsh-env.mjs";

// 与 DSH 插件同源的 WORKBUDDY* 变量（Electron 二进制路径等）先加载，
// 再构造凭据层 —— 密钥提供者在构造时读取这些变量。
loadDshEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
// 可用 WORKBUDDY_BRIDGE_CONFIG 指向另一份配置文件（例如国际版实例 config.ai.json）
const CONFIG_PATH = process.env.WORKBUDDY_BRIDGE_CONFIG
  ? resolve(process.env.WORKBUDDY_BRIDGE_CONFIG)
  : join(HERE, "config.json");
// 运行态缓存（模型目录）默认放脚本旁的 state/；Hermes 插件会通过
// WORKBUDDY_BRIDGE_STATE 指到插件数据目录，安装目录里不写运行态。
const STATE_DIR = process.env.WORKBUDDY_BRIDGE_STATE
  ? resolve(process.env.WORKBUDDY_BRIDGE_STATE)
  : join(HERE, "state");
const UPSTREAM_ERROR_STATUS = { hard_credit: 402, soft_rate: 429, session_dead: 401, not_found: 502, server: 502, client: 400 };

// ─────────────────────────── 配置 ───────────────────────────

function loadConfig() {
  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  }
  let changed = false;
  if (typeof config.port !== "number") { config.port = 39621; changed = true; }
  if (typeof config.variant !== "string") { config.variant = "workbuddy"; changed = true; }
  if (typeof config.token !== "string" || config.token.length < 16) {
    config.token = randomBytes(32).toString("base64url");
    changed = true;
  }
  if (typeof config.catalogRefreshMinutes !== "number") { config.catalogRefreshMinutes = 10; changed = true; }
  // 积分查询每次都真实打到计费接口，按 TTL 缓存（0 = 每次都查）
  if (typeof config.creditsCacheSeconds !== "number") { config.creditsCacheSeconds = 60; changed = true; }
  if (changed) writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/**
 * 端口优先级：WORKBUDDY_BRIDGE_PORT 环境变量 > 配置文件 > 39621。
 * 环境变量优先是为了让插件在"改了端口设置但配置文件还是旧值"时也能正确起进程
 * （历史缺陷：插件只在配置文件不存在时写 port，改端口后旧值一直生效）。
 */
function resolvePort(config) {
  const override = Number(process.env.WORKBUDDY_BRIDGE_PORT);
  if (Number.isFinite(override) && override >= 1 && override <= 65535) return Math.floor(override);
  const configured = Number(config.port);
  if (Number.isFinite(configured) && configured >= 1 && configured <= 65535) return Math.floor(configured);
  return 39621;
}

const config = loadConfig();
const variant = variantFor(config.variant) ?? CN_VARIANT;
const PORT = resolvePort(config);
const kernelInfo = describeKernel();
// system prompt 策略按协议面分别解析（Anthropic 面的默认值沿用旧的 replace 行为，避免回归）
const chatPolicy = resolveSystemPolicy(config, variant.id, "chat");
const anthropicPolicy = resolveSystemPolicy(config, variant.id, "anthropic");
const catalogRefreshMs = Math.max(1, config.catalogRefreshMinutes) * 60_000;
// 目录缓存按变体分开，避免国内版与国际版实例互相覆盖
const CACHE_PATH = join(STATE_DIR, `catalog-cache-${variant.id}.json`);

// ─────────────────────────── 凭据 + 上游 ───────────────────────────

const client = new WorkBuddyUpstreamClient();
const store = new WorkBuddyCredentialStore({
  variant,
  refresh: (credential) => client.refreshToken(credential),
  keyProvider: atRestKeyProviderFor(variant),
});

// ─────────────────────────── 模型目录 ───────────────────────────

const catalog = { models: [], fetchedAtMs: 0, lastError: null, source: "none" };

/** Normalize any roster shape (array or id→row object) into an array of rows with string ids. */
function normalizeRows(rows) {
  if (Array.isArray(rows)) return rows.filter((row) => row && typeof row.id === "string");
  if (rows && typeof rows === "object") {
    return Object.entries(rows)
      .map(([id, value]) => ({ id, ...(value && typeof value === "object" ? value : {}) }))
      .filter((row) => typeof row.id === "string");
  }
  return [];
}

function loadCachedCatalog() {
  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    const rows = normalizeRows(cached.models);
    if (rows.length > 0) {
      catalog.models = rows;
      catalog.fetchedAtMs = typeof cached.fetchedAtMs === "number" ? cached.fetchedAtMs : 0;
      catalog.source = "cache-file";
    }
  } catch { /* no cache yet */ }
}

/** Read-only peek at the DSH plugin's saved catalog (shared ~/.dsh), as a last resort. */
function loadDshSavedCatalog() {
  try {
    const path = join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), variant.catalogFilename);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const entries = saved && typeof saved.entries === "object" ? Object.values(saved.entries) : [];
    for (const entry of entries) {
      const rows = normalizeRows(entry?.models);
      if (rows.length > 0) return rows;
    }
  } catch { /* nothing saved */ }
  return [];
}

function fallbackRows() {
  return normalizeRows(variant.id === AI_VARIANT.id ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS);
}

function saveCachedCatalog() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, `${JSON.stringify({ fetchedAtMs: catalog.fetchedAtMs, models: catalog.models }, null, 2)}\n`);
  } catch { /* cache is best-effort */ }
}

async function refreshCatalog({ force = false } = {}) {
  const age = Date.now() - catalog.fetchedAtMs;
  if (!force && catalog.models.length > 0 && age < catalogRefreshMs) return;
  try {
    const credential = await store.resolve();
    const models = await client.fetchModels(credential);
    catalog.models = models;
    catalog.fetchedAtMs = Date.now();
    catalog.lastError = null;
    catalog.source = "live";
    saveCachedCatalog();
    log(`catalog refreshed: ${models.length} models`);
  } catch (error) {
    catalog.lastError = error instanceof Error ? error.message : String(error);
    log(`catalog refresh failed: ${catalog.lastError}`);
    if (catalog.models.length === 0) {
      const dshRows = loadDshSavedCatalog();
      if (dshRows.length > 0) {
        catalog.models = dshRows;
        catalog.source = "dsh-saved";
      }
    }
    if (catalog.models.length === 0) {
      catalog.models = fallbackRows();
      catalog.source = "builtin-fallback";
    }
  }
}

// ─────────────────────────── 倍率 / 积分（展示用） ───────────────────────────

/**
 * 展示用的模型行：叠加“当前生效”的促销（与 DSH 同源逻辑），得到实时倍率与促销徽章。
 * multiplier 形如 `x0.79`（上游串去掉尾部 credits 单位）；促销写死折后价时上游无法还原
 * 原价，此时 rateUnknown = true（DSH 显示“价格未知”）。
 */
function displayRows(now = Date.now()) {
  return catalog.models.map((model) => {
    const live = modelWithCurrentPromotion(model, now);
    return {
      id: live.id,
      name: typeof live.name === "string" ? live.name : live.id,
      contextWindow: typeof live.contextWindow === "number" ? live.contextWindow : null,
      maxTokens: typeof live.maxTokens === "number" ? live.maxTokens : null,
      multiplier: normalizeCredits(live.billing?.credits) ?? null,
      badges: Array.isArray(live.billing?.badges) ? live.billing.badges : [],
      free: live.billing?.free === true,
      rateUnknown: live.billing?.rateUnknown === true,
    };
  });
}

const creditsCache = { data: null, fetchedAtMs: 0, lastError: null, inflight: null };

/** 积分（含各套餐余量）。TTL 内走缓存；并发请求合并成一次上游计费查询。 */
async function readCredits({ force = false } = {}) {
  const ttlMs = Math.max(0, config.creditsCacheSeconds) * 1000;
  if (!force && creditsCache.data !== null && Date.now() - creditsCache.fetchedAtMs < ttlMs) return creditsCache;
  if (creditsCache.inflight !== null) return creditsCache.inflight;
  creditsCache.inflight = (async () => {
    try {
      const credential = await store.resolve();
      creditsCache.data = await client.fetchCredits(credential);
      creditsCache.fetchedAtMs = Date.now();
      creditsCache.lastError = null;
    } catch (error) {
      creditsCache.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      creditsCache.inflight = null;
    }
    return creditsCache;
  })();
  return creditsCache.inflight;
}

/** 账号与令牌有效期；拿不到返回 null（绝不抛）。 */
async function readAccount() {
  try {
    const credential = await store.resolve();
    return {
      uid: credential.uid === "" ? null : credential.uid,
      domain: credential.domain === "" ? null : credential.domain,
      source: typeof credential.source === "string" ? credential.source : null,
      expiresAt: Number.isFinite(credential.expiresAtMs) ? new Date(credential.expiresAtMs).toISOString() : null,
    };
  } catch {
    return null;
  }
}

/** 给桌面插件/脚本的一站式快照：登录态 + 账号 + 积分 + 带倍率的模型表。 */
async function statusPayload({ force = false } = {}) {
  await refreshCatalog();
  let signIn = null;
  try {
    signIn = await store.status();
  } catch { /* 未登录时 status 也可能抛 */ }
  const [account, credits] = await Promise.all([readAccount(), readCredits({ force })]);
  return {
    variant: variant.id,
    displayName: variant.displayName,
    signIn,
    account,
    credits: credits.data,
    creditsFetchedAt: credits.fetchedAtMs === 0 ? null : new Date(credits.fetchedAtMs).toISOString(),
    creditsError: credits.lastError,
    models: displayRows(),
    catalogSource: catalog.source,
    catalogFetchedAt: catalog.fetchedAtMs === 0 ? null : new Date(catalog.fetchedAtMs).toISOString(),
  };
}

// ─────────────────────────── HTTP 工具 ───────────────────────────

/** 桌面插件的渲染进程是跨源请求（本地 127.0.0.1），需要放行 CORS；鉴权仍走 Bearer。 */
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function log(...args) {
  process.stdout.write(`[workbuddy-bridge] ${new Date().toISOString()} ${args.join(" ")}\n`);
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } });
}

function bearerOk(req) {
  // 两种鉴权头都接受：Authorization: Bearer …（Hermes/Codex/Claude Code）与
  // x-api-key（Anthropic 原生客户端、pi-ai 的某些 provider 实现）。
  let presented = null;
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null) presented = match[1];
  }
  if (presented === null) {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.trim() !== "") presented = apiKey.trim();
  }
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Assemble an SSE stream into one non-streaming chat completion document. */
async function assembleCompletion(webBody, fallbackModel) {
  const reader = Readable.fromWeb(webBody);
  let buffer = "";
  let id = null;
  let created = null;
  let model = fallbackModel;
  let content = "";
  let finishReason = null;
  let usage = null;
  const toolCalls = new Map();
  for await (const chunk of reader) {
    buffer += chunk.toString("utf8");
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
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      },
      finish_reason: finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
    }],
    ...(usage === null ? {} : { usage }),
  };
}

// ─────────────────────────── 路由 ───────────────────────────

async function handle(req, res) {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (process.env.WORKBUDDY_BRIDGE_DEBUG === "1") {
    log(`request ${req.method} ${url} anthropic=${req.headers["anthropic-version"] ?? "-"}`);
  }
  try {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Claude Code 启动时会探测 /v1/api/hello（HEAD/GET）——无鉴权的健康检查
    if ((req.method === "GET" || req.method === "HEAD") && (path === "/v1/api/hello" || path === "/api/hello")) {
      writeJson(res, 200, { ok: true, service: "workbuddy-bridge" });
      return;
    }
    if (!bearerOk(req)) {
      if (process.env.WORKBUDDY_BRIDGE_DEBUG === "1") {
        const used = typeof req.headers.authorization === "string"
          ? "authorization"
          : (typeof req.headers["x-api-key"] === "string" ? "x-api-key" : "none");
        log(`auth failed: ${req.method} ${path} header=${used}`);
      }
      writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
      return;
    }
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      const signIn = await store.status();
      writeJson(res, 200, {
        ok: catalog.models.length > 0 && signIn.state === "signed-in",
        variant: variant.id,
        displayName: variant.displayName,
        signIn,
        models: catalog.models.length,
        catalogSource: catalog.source,
        catalogFetchedAt: catalog.fetchedAtMs === 0 ? null : new Date(catalog.fetchedAtMs).toISOString(),
        catalogError: catalog.lastError,
        // 供 wbconnect doctor 判断"跑的是哪一版内核、system 策略是什么"
        kernel: {
          source: kernelInfo.source,
          version: kernelInfo.version,
          sha256: kernelInfo.sha256.slice(0, 16),
          matchesRecord: kernelInfo.matchesRecord,
        },
        policy: {
          chat: chatPolicy.mode,
          anthropic: anthropicPolicy.mode,
        },
        port: PORT,
      });
      return;
    }
    // 一站式快照（桌面插件用）：登录态 + 账号 + 积分 + 带倍率的模型表
    if (req.method === "GET" && url.startsWith("/v1/status")) {
      writeJson(res, 200, await statusPayload({ force: /[?&]refresh=1/.test(url) }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1/credits")) {
      const [signIn, account, credits] = await Promise.all([
        store.status().catch(() => null),
        readAccount(),
        readCredits({ force: /[?&]refresh=1/.test(url) }),
      ]);
      writeJson(res, 200, {
        variant: variant.id,
        displayName: variant.displayName,
        signIn,
        account,
        credits: credits.data,
        fetchedAt: credits.fetchedAtMs === 0 ? null : new Date(credits.fetchedAtMs).toISOString(),
        error: credits.lastError,
      });
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1/catalog")) {
      await refreshCatalog();
      writeJson(res, 200, {
        object: "list",
        variant: variant.id,
        displayName: variant.displayName,
        source: catalog.source,
        fetchedAt: catalog.fetchedAtMs === 0 ? null : new Date(catalog.fetchedAtMs).toISOString(),
        error: catalog.lastError,
        data: displayRows(),
      });
      return;
    }
    if (req.method === "GET" && (path === "/v1/models" || path === "/v1/models/")) {
      await refreshCatalog();
      const rows = displayRows();
      // Anthropic 客户端（Claude Code）用自己的模型目录做校验：按 anthropic 形状返回别名 + 真实模型
      if (typeof req.headers["anthropic-version"] === "string" || /[?&]beta(=|&|$)/.test(url)) {
        writeJson(res, 200, anthropicModelList(rows));
        return;
      }
      writeJson(res, 200, {
        object: "list",
        data: rows.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "workbuddy",
          name: model.name,
          context_length: model.contextWindow ?? undefined,
          max_tokens: model.maxTokens ?? undefined,
          // 非标准扩展字段：倍率 / 促销徽章（Hermes 忽略，插件与脚本使用）
          multiplier: model.multiplier ?? undefined,
          badges: model.badges.length > 0 ? model.badges : undefined,
          free: model.free,
          rate_unknown: model.rateUnknown || undefined,
        })),
      });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await chatCompletions(req, res);
      return;
    }
    // Anthropic 兼容端点（Claude Code 等）：/v1/messages
    if (req.method === "POST" && (path === "/v1/messages" || path === "/v1/messages/")) {
      await anthropicMessages(req, res);
      return;
    }
    if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/v1/messages/count_tokens/")) {
      await anthropicCountTokens(req, res);
      return;
    }
    writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`request failed: ${message}`);
    if (!res.headersSent) writeOpenAIError(res, 500, "internal", message);
    else res.end();
  }
}

/** 上游偶尔用 11128（“请求被拦截，请重新发送”）做限流/风控——退避重试几次。 */
async function chatStreamWithRetry(credential, prepared, signal, attempts = 3) {
  let result = await client.chatStream(credential, prepared, signal);
  for (let i = 1; i <= attempts && result.ok === false && String(result.message ?? "").includes("11128"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200 * i));
    result = await client.chatStream(credential, prepared, signal);
  }
  return result;
}

async function chatCompletions(req, res) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.trim().toLowerCase().startsWith("application/json")) {
    writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
    return;
  }

  let credential;
  try {
    credential = await store.resolve();
  } catch (error) {
    writeOpenAIError(res, 401, "not_signed_in", error instanceof Error ? error.message : String(error));
    return;
  }

  const raw = (await readBody(req)).toString("utf8");
  // OpenAI 语义：省略 stream 即非流式（Hermes 的辅助调用——标题/视觉等——就是这样发的；
  // 之前默认 true 会把 SSE 原文塞给期待 JSON 的客户端，表现为 “invalid response (type=str)”）
  let streamRequested = false;
  let requestModel = "workbuddy";
  try {
    const parsed = JSON.parse(raw);
    streamRequested = parsed?.stream === true;
    if (typeof parsed?.model === "string") requestModel = parsed.model;
  } catch { /* upstream will report */ }

  const prepared = applyChatBody(prepareChatBody(raw), chatPolicy);
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const result = await chatStreamWithRetry(credential, prepared, controller.signal);
  if (!result.ok) {
    const status = UPSTREAM_ERROR_STATUS[result.kind] ?? 502;
    const detail = String(result.message ?? "").slice(0, 400);
    writeOpenAIError(res, status, result.kind, `workbuddy upstream ${result.kind} (http ${result.status}): ${detail}`);
    return;
  }

  if (!streamRequested) {
    const completion = await assembleCompletion(result.response.body, requestModel);
    writeJson(res, 200, completion);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let sawDone = false;
  const body = Readable.fromWeb(result.response.body);
  body.on("data", (chunk) => { if (chunk.includes("[DONE]")) sawDone = true; });
  body.on("error", (error) => {
    log(`upstream stream failed mid-flight: ${error}`);
    if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
  });
  body.pipe(res);
}

// ─────────────────────────── Anthropic 兼容层（/v1/messages） ───────────────────────────

function writeAnthropicError(res, status, type, message) {
  writeJson(res, status, { type: "error", error: { type, message } });
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

// Claude Code 会在本地校验模型名；这里暴露它认识的别名 + 桥接的真实模型。
// 别名在 /v1/messages 里由 resolveAnthropicModel 映射到真实 WorkBuddy 模型。
const ANTHROPIC_MODEL_ALIASES = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-sonnet-4-0",
  "claude-3-5-haiku-20241022",
];

function anthropicModelList(rows) {
  const seen = new Set();
  const data = [];
  const push = (id, name) => {
    if (typeof id !== "string" || id === "" || seen.has(id)) return;
    seen.add(id);
    data.push({
      type: "model",
      id,
      display_name: typeof name === "string" && name !== "" ? name : id,
      created_at: "2025-01-01T00:00:00Z",
    });
  };
  for (const alias of ANTHROPIC_MODEL_ALIASES) push(alias, alias);
  for (const row of rows) push(row.id, row.name);
  return {
    data,
    has_more: false,
    first_id: data.length > 0 ? data[0].id : null,
    last_id: data.length > 0 ? data[data.length - 1].id : null,
  };
}

function resolveAnthropicModel(model) {
  const aliases = config.modelAliases && typeof config.modelAliases === "object" ? config.modelAliases : {};
  if (typeof aliases[model] === "string" && aliases[model] !== "") return aliases[model];
  if (/^claude/i.test(model)) {
    return typeof config.anthropicDefaultModel === "string" && config.anthropicDefaultModel !== ""
      ? config.anthropicDefaultModel
      : "deepseek-v4.1-flash";
  }
  return model;
}

// system prompt 的改写策略已收敛到 lib/system-policy.mjs（OpenAI / Anthropic 两个协议面共用），
// 这里只做协议转换，不再各自持有"中性提示词"与替换阈值。

function safeJsonParse(value) {
  if (typeof value !== "string" || value.trim() === "") return {};
  try { return JSON.parse(value); } catch { return {}; }
}

/** Anthropic content blocks -> OpenAI chat messages. */
function toOpenAIMessages(body) {
  const messages = [];
  const system = body?.system;
  const systemText = system === undefined || system === null
    ? ""
    : typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
        : "";
  const cleanSystem = sanitizeSystemText(systemText);
  if (cleanSystem !== "") messages.push({ role: "system", content: cleanSystem });

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = message?.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === "assistant") {
      const texts = [];
      const toolCalls = [];
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : `toolu_${randomBytes(8).toString("hex")}`,
            type: "function",
            function: {
              name: typeof block.name === "string" ? block.name : "tool",
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const out = { role: "assistant" };
      if (texts.length > 0) out.content = texts.join("\n");
      if (toolCalls.length > 0) {
        out.tool_calls = toolCalls;
        if (out.content === undefined) out.content = null;
      }
      messages.push(out);
    } else {
      const texts = [];
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        else if (block.type === "image") texts.push("[image omitted: upstream chat API has no image input]");
        else if (block.type === "tool_result") {
          let output = block.content;
          if (Array.isArray(output)) {
            output = output.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
          }
          messages.push({
            role: "tool",
            tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
          });
        }
      }
      if (texts.length > 0) messages.push({ role: "user", content: texts.join("\n") });
    }
  }
  return messages;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: tool.input_schema && typeof tool.input_schema === "object"
          ? tool.input_schema
          : { type: "object", properties: {} },
      },
    }));
  return mapped.length > 0 ? mapped : undefined;
}

function toOpenAIToolChoice(choice) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function toAnthropicMessage(completion, model) {
  const choice = (Array.isArray(completion?.choices) ? completion.choices[0] : null) ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id !== "" ? call.id : `toolu_${randomBytes(8).toString("hex")}`,
      name: call.function?.name ?? "tool",
      input: safeJsonParse(call.function?.arguments),
    });
  }
  return {
    id: `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion?.usage?.prompt_tokens ?? 0,
      output_tokens: completion?.usage?.completion_tokens ?? 0,
    },
  };
}

async function streamAnthropic(upstreamBody, res, model) {
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  send("message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let nextIndex = 0;
  let textIndex = null;
  const toolBlocks = new Map();
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let buffer = "";
  const reader = Readable.fromWeb(upstreamBody);
  for await (const chunk of reader) {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event.usage && typeof event.usage === "object") {
        usage = {
          input_tokens: event.usage.prompt_tokens ?? usage.input_tokens,
          output_tokens: event.usage.completion_tokens ?? usage.output_tokens,
        };
      }
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content !== "") {
        if (textIndex === null) {
          textIndex = nextIndex++;
          send("content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        send("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const key = typeof call.index === "number" ? call.index : 0;
          let block = toolBlocks.get(key);
          if (!block) {
            block = { index: nextIndex++, id: `toolu_${randomBytes(8).toString("hex")}`, name: "tool", started: false };
            toolBlocks.set(key, block);
          }
          if (typeof call.id === "string" && call.id !== "") block.id = call.id;
          if (call.function && typeof call.function.name === "string" && call.function.name !== "") {
            block.name = call.function.name;
          }
          if (!block.started) {
            block.started = true;
            send("content_block_start", {
              type: "content_block_start",
              index: block.index,
              content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            });
          }
          if (call.function && typeof call.function.arguments === "string" && call.function.arguments !== "") {
            send("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: call.function.arguments },
            });
          }
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
        stopReason = anthropicStopReason(choice.finish_reason);
      }
    }
  }

  const indices = [...toolBlocks.values()].map((block) => block.index);
  if (textIndex !== null) indices.push(textIndex);
  indices.sort((a, b) => a - b).forEach((index) => {
    send("content_block_stop", { type: "content_block_stop", index });
  });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

async function anthropicMessages(req, res) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.trim().toLowerCase().startsWith("application/json")) {
    writeAnthropicError(res, 415, "invalid_request_error", "Content-Type must be application/json");
    return;
  }
  let credential;
  try {
    credential = await store.resolve();
  } catch (error) {
    writeAnthropicError(res, 401, "authentication_error", error instanceof Error ? error.message : String(error));
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch {
    writeAnthropicError(res, 400, "invalid_request_error", "invalid JSON body");
    return;
  }
  const requestedModel = typeof body.model === "string" && body.model !== "" ? body.model : "workbuddy";
  const model = resolveAnthropicModel(requestedModel);
  const openaiBody = {
    model,
    messages: applyMessages(toOpenAIMessages(body), anthropicPolicy),
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    top_p: typeof body.top_p === "number" ? body.top_p : undefined,
    stop: Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0 ? body.stop_sequences : undefined,
    tools: toOpenAITools(body.tools),
    tool_choice: toOpenAIToolChoice(body.tool_choice),
    stream: true,
  };
  for (const key of Object.keys(openaiBody)) {
    if (openaiBody[key] === undefined) delete openaiBody[key];
  }
  if (process.env.WORKBUDDY_BRIDGE_DEBUG === "1") {
    const serialized = JSON.stringify(openaiBody);
    log(`anthropic->openai ${serialized.length} bytes model=${openaiBody.model} tools=${Array.isArray(openaiBody.tools) ? openaiBody.tools.length : 0} msgs=${openaiBody.messages.length} max_tokens=${openaiBody.max_tokens ?? "-"}`);
    log(`body head: ${serialized.slice(0, 400)}`);
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const systemMessage = openaiBody.messages.find((m) => m.role === "system");
      const systemText = typeof systemMessage?.content === "string" ? systemMessage.content : "";
      if (systemText.length > 10000) {
        writeFileSync(join(STATE_DIR, "last-anthropic-system.txt"), systemText);
        writeFileSync(join(STATE_DIR, "last-anthropic-tools.json"), JSON.stringify(openaiBody.tools ?? []));
        writeFileSync(join(STATE_DIR, "last-anthropic-body.json"), JSON.stringify(openaiBody));
      }
    } catch { /* debug dump is best-effort */ }
  }
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const prepared = prepareChatBody(JSON.stringify(openaiBody));
  const result = await chatStreamWithRetry(credential, prepared, controller.signal);
  if (!result.ok) {
    const status = UPSTREAM_ERROR_STATUS[result.kind] ?? 502;
    writeAnthropicError(res, status, "api_error",
      `workbuddy upstream ${result.kind} (http ${result.status}): ${String(result.message ?? "").slice(0, 400)}`);
    return;
  }
  // Anthropic 规范：只有显式 stream: true 才走 SSE，缺省是非流式 JSON
  if (body.stream !== true) {
    const completion = await assembleCompletion(result.response.body, model);
    writeJson(res, 200, toAnthropicMessage(completion, requestedModel));
    return;
  }
  await streamAnthropic(result.response.body, res, requestedModel);
}

async function anthropicCountTokens(req, res) {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const text = JSON.stringify({ system: body?.system ?? "", messages: body?.messages ?? [], tools: body?.tools ?? [] });
    writeJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
  } catch {
    writeJson(res, 200, { input_tokens: 1 });
  }
}

// ─────────────────────────── 启动 ───────────────────────────

loadCachedCatalog();
await refreshCatalog({ force: true });

const server = createServer((req, res) => { handle(req, res); });
server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT} (variant ${variant.id}, ${catalog.models.length} models from ${catalog.source})`);
  log(`kernel ${kernelInfo.source}@${kernelInfo.version} sha256=${kernelInfo.sha256.slice(0, 16)}… policy chat=${chatPolicy.mode} anthropic=${anthropicPolicy.mode}`);
  if (kernelInfo.warning !== null) log(`kernel warning: ${kernelInfo.warning}`);
  if (catalog.lastError !== null) log(`catalog warning: ${catalog.lastError}`);
});

setInterval(() => { refreshCatalog().catch(() => {}); }, catalogRefreshMs).unref();
