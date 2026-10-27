import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 测试进程绝不能真的去拉起桥接（apply 会安排一次自动启动）
process.env.WORKBUDDY_NO_AUTOSTART = "1";

import { apply, bridgeLauncher, dataDir, providersRegistered, readConfig, summarize } from "../index.js";

test("dataDir honours WORKBUDDY_BRIDGE_DATA", () => {
  const previous = process.env.WORKBUDDY_BRIDGE_DATA;
  process.env.WORKBUDDY_BRIDGE_DATA = "D:\\tmp\\bridge";
  try {
    assert.equal(dataDir(), "D:\\tmp\\bridge");
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_BRIDGE_DATA;
    else process.env.WORKBUDDY_BRIDGE_DATA = previous;
  }
});

test("readConfig returns null for a missing file", () => {
  assert.equal(readConfig("D:\\definitely-missing", "config.json"), null);
});

test("summarize keeps credits and model rates, drops everything else", () => {
  const summary = summarize({
    credits: {
      total: 1791,
      unlimited: false,
      cycleResetTime: "2026-11-01",
      accounts: [{ packageName: "Pro", remain: 800, size: 1000, endTimeMs: 1790000000000 }],
    },
    account: { uid: "u-123", domain: "www.workbuddy.cn", expiresAt: "2026-11-20T00:00:00Z", source: "desktop" },
    catalogSource: "live",
    creditsFetchedAt: "2026-10-26T05:00:00Z",
    models: [
      { id: "hy3", name: "Hy3", multiplier: "x0.00", free: true, badges: ["限时免费"], contextWindow: 192000 },
      {
        id: "hy4-preview", name: "Hy4", contextWindow: 200000, defaultContextWindow: 200000,
        supportedContextWindows: [200000, 1000000],
      },
      { id: "glm-5.3-flash", name: "GLM-5.3-Flash", multiplier: "x0.11", rateUnknown: true, badges: [] },
      { id: "" },
      { id: "bad", name: 1, multiplier: 3 },
    ],
    signIn: { state: "signed-in" },
    token: "should-not-appear",
  }, "workbuddy", "WorkBuddy", { contextWindowPolicy: "max" });

  assert.equal(summary.ok, true);
  assert.equal(summary.signIn, "signed-in");
  assert.equal(summary.contextWindowPolicy, "max");
  assert.equal(summary.credits.total, 1791);
  assert.deepEqual(summary.credits.packages, [{ name: "Pro", remain: 800, size: 1000, endTimeMs: 1790000000000 }]);
  assert.equal(summary.account.domain, "www.workbuddy.cn");
  assert.equal(summary.account.uid, "u-123");
  assert.equal(summary.catalogSource, "live");
  assert.equal(summary.creditsFetchedAt, "2026-10-26T05:00:00Z");
  assert.equal(summary.models.length, 4, "空 id 被丢弃，其余保留");
  assert.equal(summary.models[0].free, true);
  assert.equal(summary.models[0].contextWindow, 192000);
  assert.deepEqual(summary.models[1].supportedContextWindows, [200000, 1000000]);
  assert.equal(summary.models[1].defaultContextWindow, 200000);
  assert.equal(summary.models[2].rateUnknown, true);
  assert.equal(summary.models[2].multiplier, "x0.11");
  // 非字符串 name / multiplier 回退为 id 与 null，而不是把脏值透给 UI
  assert.equal(summary.models[3].name, "bad");
  assert.equal(summary.models[3].multiplier, null);
  assert.equal(JSON.stringify(summary).includes("should-not-appear"), false);
});

test("summarize tolerates missing credits/models", () => {
  const summary = summarize({}, "workbuddy-ai", "WorkBuddy AI");
  assert.equal(summary.credits, null);
  assert.deepEqual(summary.models, []);
});

test("providersRegistered 能区分有没有注册 WorkBuddy provider", () => {
  assert.equal(providersRegistered({ listProviders: () => [{ id: "deepseek-account" }] }), false);
  assert.equal(providersRegistered({ listProviders: () => [{ id: "workbuddy" }] }), true);
  assert.equal(providersRegistered({ listProviders: () => [{ name: "WorkBuddy AI" }] }), true);
  assert.equal(providersRegistered({ listProviders: () => [{ title: "Custom: workbuddy-ai" }] }), true);
});

test("providersRegistered 拿不到信息时返回 null（不误报）", () => {
  assert.equal(providersRegistered(null), null);
  assert.equal(providersRegistered(undefined), null);
  assert.equal(providersRegistered({}), null);
  assert.equal(providersRegistered({ listProviders: () => null }), null);
  assert.equal(providersRegistered({ listProviders: () => { throw new Error("boom"); } }), null);
});

function makeCtx() {
  const routes = [];
  const ctx = {
    effect: (fn) => { fn(); },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    get: () => null,
  };
  return { ctx, routes };
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test("apply 注册三条 exact 路由（单条 exact 覆盖不了多个路径）", () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`).sort(),
    ["exact /workbuddy/beacon", "exact /workbuddy/client-beacon", "exact /workbuddy/status"],
  );
});

test("beacon 路由可写可读，初始为空", async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const readRoute = routes.find((route) => route.path === "/workbuddy/beacon").handler;
  const writeRoute = routes.find((route) => route.path === "/workbuddy/client-beacon").handler;

  let res = makeRes();
  readRoute({ method: "GET", url: "/workbuddy/beacon" }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { beacon: null });

  const { Readable } = await import("node:stream");
  const req = Readable.from([JSON.stringify({ build: "2.1.0+test", slots: [] })]);
  req.method = "POST";
  req.url = "/workbuddy/client-beacon";
  res = makeRes();
  await writeRoute(req, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });

  res = makeRes();
  readRoute({ method: "GET", url: "/workbuddy/beacon" }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.beacon.body.build, "2.1.0+test");
});

test("单条路由注册失败不能拖垮整个 Host 半", () => {
  const routes = [];
  const ctx = {
    effect: (fn) => { fn(); },
    webServer: {
      register: (route) => {
        if (route.path === "/workbuddy/beacon") throw new Error("route rejected by host");
        routes.push(route);
        return () => {};
      },
    },
    get: () => null,
  };

  assert.doesNotThrow(() => apply(ctx), "一条路由被拒时 apply 不能抛错");
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    ["/workbuddy/client-beacon", "/workbuddy/status"],
  );
});

test("bridgeLauncher 只在仓库存在 bin/ 启动器时返回路径", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-launcher-"));
  assert.equal(bridgeLauncher(root, "win32"), null, "没有 bin/ 时必须返回 null");

  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "wbconnect.cmd"), "@echo off\n");
  assert.equal(bridgeLauncher(root, "win32"), join(root, "bin", "wbconnect.cmd"));
  assert.equal(bridgeLauncher(root, "linux"), null, "POSIX 找的是没有扩展名的脚本");
});

test("bridgeLauncher 默认指向本仓库的启动器", () => {
  const launcher = bridgeLauncher();
  assert.ok(launcher, "仓库里应当能找到 bin/wbconnect(.cmd)");
  assert.match(launcher, /bin[\\/]wbconnect(\.cmd)?$/, launcher);
});
