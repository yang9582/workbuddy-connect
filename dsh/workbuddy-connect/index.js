/**
 * WorkBuddy Connect 的 Host 半。
 *
 * 浏览器端拿不到桥接令牌（令牌只存在本机 config.json / ~/.dsh/.env），
 * 所以由 Host 读取桥接配置并代访问 `/v1/status`，对外只暴露"积分 + 倍率"这类展示数据。
 * 路由是同源的 `/workbuddy/status`，Web UI 直接 fetch，不需要 CORS、也不接触令牌。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 4_000;

export const VARIANTS = [
  { key: "workbuddy", file: "config.json", label: "WorkBuddy" },
  { key: "workbuddy-ai", file: "config.ai.json", label: "WorkBuddy AI" },
];

/** 与 Python 侧 service.data_dir() 保持一致的桥接数据目录。 */
export function dataDir() {
  const env = typeof process.env.WORKBUDDY_BRIDGE_DATA === "string" ? process.env.WORKBUDDY_BRIDGE_DATA.trim() : "";
  if (env !== "") return env;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "hermes-workbuddy-bridge");
  }
  return join(homedir(), ".local", "share", "hermes-workbuddy-bridge");
}

export function readConfig(dir, file) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 把桥接 `/v1/status` 裁成 UI 需要的形状（绝不带令牌）。 */
export function summarize(status, key, label, config = {}) {
  const credits = status && typeof status.credits === "object" && status.credits !== null ? status.credits : null;
  const accounts = Array.isArray(credits?.accounts) ? credits.accounts : [];
  const models = Array.isArray(status?.models) ? status.models : [];
  const account = status && typeof status.account === "object" && status.account !== null ? status.account : null;
  const contextMode = String(config?.contextWindowPolicy || "max").toLowerCase() === "default" ? "default" : "max";
  return {
    key,
    label,
    ok: true,
    signIn: status?.signIn?.state ?? null,
    // 只回传策略名，不暴露整份桥接配置
    contextWindowPolicy: contextMode,
    account: account === null ? null : {
      uid: typeof account.uid === "string" ? account.uid : null,
      domain: typeof account.domain === "string" ? account.domain : null,
      expiresAt: typeof account.expiresAt === "string" ? account.expiresAt : null,
      source: typeof account.source === "string" ? account.source : null,
    },
    catalogSource: typeof status?.catalogSource === "string" ? status.catalogSource : null,
    creditsFetchedAt: typeof status?.creditsFetchedAt === "string" ? status.creditsFetchedAt : null,
    credits: credits === null ? null : {
      total: typeof credits.total === "number" ? credits.total : null,
      unlimited: credits.unlimited === true,
      cycleResetTime: typeof credits.cycleResetTime === "string" ? credits.cycleResetTime : null,
      packages: accounts.map((account) => ({
        name: typeof account?.packageName === "string" ? account.packageName : null,
        remain: typeof account?.remain === "number" ? account.remain : null,
        size: typeof account?.size === "number" ? account.size : null,
        endTimeMs: typeof account?.endTimeMs === "number" ? account.endTimeMs : null,
      })),
    },
    models: models
      .filter((model) => typeof model?.id === "string" && model.id !== "")
      .map((model) => ({
        id: model.id,
        name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : null,
        defaultContextWindow: typeof model.defaultContextWindow === "number" ? model.defaultContextWindow : null,
        supportedContextWindows: Array.isArray(model.supportedContextWindows)
          ? model.supportedContextWindows.filter((value) => typeof value === "number" && value > 0)
          : [],
        multiplier: typeof model.multiplier === "string" ? model.multiplier : null,
        badges: Array.isArray(model.badges) ? model.badges.map(String) : [],
        free: model.free === true,
        rateUnknown: model.rateUnknown === true,
      })),
  };
}

async function readVariant(variant, dir, refresh) {
  const config = readConfig(dir, variant.file);
  if (config === null) return { key: variant.key, label: variant.label, ok: false, error: "未配置" };
  const port = Number(config.port);
  const token = typeof config.token === "string" ? config.token : "";
  if (!Number.isFinite(port) || token === "") {
    return { key: variant.key, label: variant.label, ok: false, error: "配置缺少 port/token" };
  }
  const url = `http://127.0.0.1:${port}/v1/status${refresh ? "?refresh=1" : ""}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return { key: variant.key, label: variant.label, ok: false, error: `桥接 HTTP ${response.status}` };
    return summarize(await response.json(), variant.key, variant.label, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { key: variant.key, label: variant.label, ok: false, error: message.slice(0, 160) };
  }
}

/** 汇总两个变体；`refresh=1` 让桥接重新查询计费接口。 */
export async function collectStatus({ refresh = false } = {}) {
  const dir = dataDir();
  const variants = await Promise.all(VARIANTS.map((variant) => readVariant(variant, dir, refresh)));
  return { fetchedAt: new Date().toISOString(), dataDir: dir, variants };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export const inject = ["webServer"];

/**
 * 判断 DSH 里是否已经注册了本插件的 provider。
 * 返回 true / false；拿不到 llm 服务时返回 null（UI 不做提示，避免误报）。
 *
 * 这覆盖了"仓库里只有模板、还没跑 `wbconnect dsh bundle`"的情况：
 * 插件能装上、卡片能显示，但模型选择器里不会有 WorkBuddy 分组。
 */
export function providersRegistered(llm) {
  try {
    if (llm === null || llm === undefined) return null;
    const list = typeof llm.listProviders === "function" ? llm.listProviders() : null;
    if (!Array.isArray(list)) return null;
    return list.some((entry) => JSON.stringify(entry ?? {}).toLowerCase().includes("workbuddy"));
  } catch {
    return null;
  }
}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      if (data.length < limit) data += chunk.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

export function apply(ctx) {
  let cache = { at: 0, data: null };
  // Client 半启动时回报一次"注册结果 + 构建标记"，用于判断浏览器加载的是哪一版模块。
  let beacon = null;
  // 路由注册失败（DSH 版本差异）记在这里，随 /workbuddy/status 回报，便于定位
  const routeErrors = [];

  const statusHandler = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const refresh = url.searchParams.get("refresh") === "1";
      const now = Date.now();
      if (!refresh && cache.data !== null && now - cache.at < CACHE_MS) {
        sendJson(res, 200, cache.data);
        return;
      }
      const data = await collectStatus({ refresh });
      // 顺带告诉 UI：provider 是否已经注册进 DSH（未生成 patch 时会是 false）
      let llm = null;
      try { llm = ctx.get("llm"); } catch { llm = null; }
      data.providerRegistered = providersRegistered(llm);
      if (routeErrors.length > 0) data.routeErrors = routeErrors.slice(0, 4);
      cache = { at: Date.now(), data };
      sendJson(res, 200, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message.slice(0, 200) });
    }
  };

  const beaconWriteHandler = async (req, res) => {
    const body = await readJsonBody(req);
    beacon = { at: new Date().toISOString(), body: body === null ? null : body };
    sendJson(res, 200, { ok: true });
  };

  const beaconReadHandler = (_req, res) => {
    sendJson(res, 200, { beacon });
  };

  // 三个独立 exact 路由：单条 exact 只匹配一个 path，其它路径会被 SPA fallback 吃掉（404）。
  // 逐条 try/catch：DSH 换版本后某条路由注册被拒时，不能让整个 Host 半 apply 失败
  // （之前一次路由改动就把插件整体搞挂，积分/倍率全没了）。
  ctx.effect(() => {
    const disposers = [];
    for (const [path, handler] of [
      ["/workbuddy/status", statusHandler],
      ["/workbuddy/beacon", beaconReadHandler],
      ["/workbuddy/client-beacon", beaconWriteHandler],
    ]) {
      try {
        disposers.push(ctx.webServer.register({ kind: "exact", path, handler }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        routeErrors.push(`${path}: ${message.slice(0, 120)}`);
      }
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 卸载时忽略单个失败 */ }
      }
    };
  });
}
