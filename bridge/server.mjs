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

// vendor/host-bundle.js 的导出使用打包后的单字母别名（见其文件末尾的 export 语句）
import {
  O as WorkBuddyUpstreamClient,     // 上游客户端：chatStream / refreshToken / fetchModels / fetchCredits
  m as WorkBuddyCredentialStore,    // 凭据存储：桌面登录态 + 自动刷新
  b as atRestKeyProviderFor,        // 加密凭据的密钥提供者（调用 App 自带 Electron 解密）
  S as CN_VARIANT,                  // 国内版 WorkBuddy
  x as AI_VARIANT,                  // 国际版 WorkBuddy AI
  w as variantFor,
  P as prepareChatBody,             // OpenAI 请求体规范化（强制 stream / developer→system / tool_choice 扁平化）
  j as modelWithCurrentPromotion,   // 叠加“当前生效”的促销 → 实时倍率 + 促销徽章（同 DSH 展示）
  M as normalizeCredits,            // 上游 credits 串 → 纯倍率（x0.79）
  u as FALLBACK_WORKBUDDY_MODELS,
  l as FALLBACK_WORKBUDDY_AI_MODELS,
} from "./vendor/host-bundle.js";
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

const config = loadConfig();
const variant = variantFor(config.variant) ?? CN_VARIANT;
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
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const a = Buffer.from(match[1]);
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
  try {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!bearerOk(req)) {
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
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
      await refreshCatalog();
      const rows = displayRows();
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
    writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`request failed: ${message}`);
    if (!res.headersSent) writeOpenAIError(res, 500, "internal", message);
    else res.end();
  }
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

  const prepared = prepareChatBody(raw);
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const result = await client.chatStream(credential, prepared, controller.signal);
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

// ─────────────────────────── 启动 ───────────────────────────

loadCachedCatalog();
await refreshCatalog({ force: true });

const server = createServer((req, res) => { handle(req, res); });
server.listen(config.port, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${config.port} (variant ${variant.id}, ${catalog.models.length} models from ${catalog.source})`);
  if (catalog.lastError !== null) log(`catalog warning: ${catalog.lastError}`);
});

setInterval(() => { refreshCatalog().catch(() => {}); }, catalogRefreshMs).unref();
