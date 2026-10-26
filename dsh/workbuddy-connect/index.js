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

/** 把桥接 `/v1/status` 裁成 UI 需要的形状（绝不带令牌或账号标识）。 */
export function summarize(status, key, label) {
  const credits = status && typeof status.credits === "object" && status.credits !== null ? status.credits : null;
  const accounts = Array.isArray(credits?.accounts) ? credits.accounts : [];
  const models = Array.isArray(status?.models) ? status.models : [];
  return {
    key,
    label,
    ok: true,
    signIn: status?.signIn?.state ?? null,
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
    return summarize(await response.json(), variant.key, variant.label);
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

export function apply(ctx) {
  let cache = { at: 0, data: null };
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/workbuddy/status",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const refresh = url.searchParams.get("refresh") === "1";
        const now = Date.now();
        if (!refresh && cache.data !== null && now - cache.at < CACHE_MS) {
          sendJson(res, 200, cache.data);
          return;
        }
        const data = await collectStatus({ refresh });
        cache = { at: Date.now(), data };
        sendJson(res, 200, data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: message.slice(0, 200) });
      }
    },
  }));
}
