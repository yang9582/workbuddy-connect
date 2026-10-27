/**
 * WorkBuddy Connect 的 Host 半。
 *
 * 浏览器端拿不到桥接令牌（令牌只存在本机 config.json / ~/.dsh/.env），
 * 所以由 Host 读取桥接配置并代访问 `/v1/status`，对外只暴露"积分 + 倍率"这类展示数据。
 * 路由是同源的 `/workbuddy/status`，Web UI 直接 fetch，不需要 CORS、也不接触令牌。
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 4_000;
// 自动拉起桥接的最小间隔：DSH 启动时多个组件会同时读状态，不能连续 spawn
const SPAWN_COOLDOWN_MS = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
/** bundle 目录在 `<repo>/dsh/workbuddy-connect/`，上两级就是仓库根。 */
const REPO_ROOT = resolve(HERE, "..", "..");

/** 找到 `bin/wbconnect` 启动器；bundle 是被拷贝出去的（没有 bin/）时返回 null。 */
export function bridgeLauncher(root = REPO_ROOT, platform = process.platform) {
  const name = platform === "win32" ? "wbconnect.cmd" : "wbconnect";
  const path = join(root, "bin", name);
  return existsSync(path) ? path : null;
}

export const VARIANTS = [
  { key: "workbuddy", file: "config.json", label: "WorkBuddy" },
  { key: "workbuddy-ai", file: "config.ai.json", label: "WorkBuddy AI" },
];

/** 与 Python 侧 service.data_dir() 保持一致的桥接数据目录。 */
export function dataDir() {
  const env = typeof process.env.WORKBUDDY_BRIDGE_DATA === "string" ? process.env.WORKBUDDY_BRIDGE_DATA.trim() : "";
  if (env !== "") return env;
  // 与 workbuddy/harnesses/base.py 完全一致：LOCALAPPDATA 优先，否则 ~/AppData/Local
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(base, "hermes-workbuddy-bridge");
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

  // ── 自动拉起桥接 ─────────────────────────────────────────
  // DSH 打开时如果桥接没在跑，插件就什么都显示不出来（重启电脑后最常见）。
  // 这里在挂载后和"状态读取失败"时各尝试启动一次，30 秒内不重复。
  const spawnState = { lastAttemptAt: null, lastError: "", attempts: 0 };

  function autostartEnabled() {
    return String(process.env.WORKBUDDY_NO_AUTOSTART || "") !== "1";
  }

  function ensureBridge(reason) {
    const launcher = bridgeLauncher();
    if (launcher === null) return "no-launcher";
    if (!autostartEnabled()) return "disabled";
    const now = Date.now();
    if (spawnState.lastAttemptAt !== null && now - spawnState.lastAttemptAt < SPAWN_COOLDOWN_MS) {
      return "throttled";
    }
    spawnState.lastAttemptAt = now;
    spawnState.attempts += 1;
    spawnState.lastError = "";
    try {
      const quoted = `"${launcher}" start`;
      const isWin = process.platform === "win32";
      // 子进程的输出写进数据目录的 autostart.log：spawn 失败时这是唯一线索
      let fd = "ignore";
      try {
        fd = openSync(join(dataDir(), "autostart.log"), "a");
        writeSync(fd, `\n[${new Date().toISOString()}] autostart (${reason}): ${quoted}\n`);
      } catch { fd = "ignore"; }
      const child = isWin
        // shell: true 让 cmd 自己处理引号；含空格的仓库路径（`D:\Program Files\...`）靠它
        ? spawn(quoted, { cwd: REPO_ROOT, shell: true, detached: true, stdio: ["ignore", fd, fd], windowsHide: true })
        : spawn(quoted, { cwd: REPO_ROOT, shell: "/bin/sh", detached: true, stdio: ["ignore", fd, fd] });
      child.on("error", (error) => {
        spawnState.lastError = String((error && error.message) || error).slice(0, 160);
      });
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) spawnState.lastError = `launcher exit ${code}`;
      });
      child.unref();
      return `spawned:${reason}`;
    } catch (error) {
      spawnState.lastError = String((error && error.message) || error).slice(0, 160);
      return "error";
    }
  }

  function autostartInfo() {
    return {
      enabled: autostartEnabled(),
      launcher: bridgeLauncher(),
      attempts: spawnState.attempts,
      lastAttemptAt: spawnState.lastAttemptAt,
      lastError: spawnState.lastError,
    };
  }


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
      // 有变体读不到（典型：重启后桥接没起来）→ 尝试自动拉起，并让 UI 知道试过了
      const variants = Array.isArray(data.variants) ? data.variants : [];
      if (variants.some((variant) => variant.ok !== true)) ensureBridge("status");
      data.bridgeAutostart = autostartInfo();
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

  // DSH 打开后稍等再尝试：不阻塞插件挂载，也给 DSH 自己启动留出时间。
  // unref：不让这个计时器拖住进程退出（测试里也不会挂住）。
  setTimeout(() => { ensureBridge("mount"); }, 1500).unref?.();
}
