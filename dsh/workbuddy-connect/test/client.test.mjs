/**
 * Client 半的结构冒烟测试（不需要浏览器）：
 * 用 vm 载入 client.js，拿到 ModuleLoader 注册的 factory，再用桩 React + 桩 ctx
 * 执行 apply，断言它注册了预期的三个插槽、注册了 locale 字典、且不抛异常。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadModule() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (module) => { captured = module; } } },
    console,
    fetch: async () => ({ ok: true, json: async () => ({ fetchedAt: "", variants: [] }) }),
    setInterval,
    clearInterval,
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  assert.ok(captured, "client.js 必须调用 window.__ModuleLoader__.load");
  return captured;
}

const ReactStub = {
  createElement: (type, props, children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

function makeCtx() {
  const registrations = [];
  const locales = [];
  const ctx = {
    effect: (fn) => { fn(); },
    locale: {
      getLocale: () => ({ active: "zh-CN", locales: [], revision: 0 }),
      register: (ns, id, dict) => { locales.push({ ns, id, keys: Object.keys(dict) }); return () => {}; },
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ slot: options.name, options, component });
        return () => {};
      },
    },
  };
  return { ctx, registrations, locales };
}

test("factory 暴露 id 与 inject", () => {
  const module = loadModule();
  assert.equal(module.id, "workbuddy-connect");
  const mod = module.factory((name) => {
    if (name === "react") return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.deepEqual([...mod.inject].sort(), ["locale", "slots"]);
});

test("apply 注册三个插槽并注册 locale 字典", async () => {
  const module = loadModule();
  const mod = module.factory(() => ReactStub);
  const { ctx, registrations, locales } = makeCtx();

  assert.doesNotThrow(() => mod.apply(ctx));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const slots = registrations.map((entry) => entry.slot).sort();
  assert.deepEqual(slots, [
    "conversation.composer.dock",
    "conversation.input.model.label",
    "settings.plugins.tab",
  ]);

  const dock = registrations.find((entry) => entry.slot === "conversation.composer.dock");
  assert.equal(dock.options.id, "workbuddy-credits");
  const tab = registrations.find((entry) => entry.slot === "settings.plugins.tab");
  assert.equal(tab.options.label, "WorkBuddy");

  // 当前语言是 zh-CN，必须同时注册 zh 与 en（回退）
  const ids = locales.map((entry) => entry.id);
  assert.ok(ids.includes("zh-CN"), `expected zh-CN in ${ids}`);
  assert.ok(ids.includes("en"), `expected en in ${ids}`);
  assert.ok(locales.every((entry) => entry.ns === "workbuddy"));
  assert.ok(locales[0].keys.includes("title"));
});

test("重复注册不抛异常（locale 已存在时降级）", () => {
  const module = loadModule();
  const mod = module.factory(() => ReactStub);
  const { ctx } = makeCtx();
  ctx.locale.register = () => { throw new Error("duplicate (ns, locale)"); };
  assert.doesNotThrow(() => mod.apply(ctx));
});
