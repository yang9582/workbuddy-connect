import assert from "node:assert/strict";
import test from "node:test";

import { dataDir, readConfig, summarize } from "../index.js";

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
