/**
 * Client 半的结构冒烟测试（不需要浏览器）：
 * 用 vm 载入 client.js，拿到 ModuleLoader 注册的 factory，再用桩 React + 桩 ctx
 * 执行 apply，断言它注册了预期的三个插槽、注册了 locale 字典、并回报自检 beacon。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const calls = [];

function loadModule() {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (module) => { captured = module; } } },
    console,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ fetchedAt: "", variants: [] }) };
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
    location: { href: "http://127.0.0.1:1/" },
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

test("apply 注册三个插槽、注册 locale 字典并回报 beacon", async () => {
  calls.length = 0;
  const module = loadModule();
  const mod = module.factory(() => ReactStub);
  const { ctx, registrations, locales } = makeCtx();

  assert.doesNotThrow(() => mod.apply(ctx));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const slots = registrations.map((entry) => entry.slot).sort();
  assert.deepEqual(slots, [
    "conversation.input.left",
    "conversation.input.model.label",
    "settings.plugins.tab",
  ]);

  const credits = registrations.find((entry) => entry.slot === "conversation.input.left");
  assert.equal(credits.options.id, "workbuddy-credits");
  assert.equal(credits.options.order, 5);
  const tab = registrations.find((entry) => entry.slot === "settings.plugins.tab");
  assert.equal(tab.options.label, "WorkBuddy");

  const ids = locales.map((entry) => entry.id);
  assert.ok(ids.includes("zh-CN"), `expected zh-CN in ${ids}`);
  assert.ok(ids.includes("en"), `expected en in ${ids}`);
  assert.ok(locales.every((entry) => entry.ns === "workbuddy"));
  assert.ok(locales[0].keys.includes("title"));

  const beacon = calls.find((call) => String(call.url).includes("/workbuddy/client-beacon"));
  assert.ok(beacon, "apply 之后必须回报 beacon");
  const payload = JSON.parse(beacon.init.body);
  assert.match(payload.build, /^2\.1\.0\+/);
  assert.equal(payload.locale, "zh-CN");
  assert.deepEqual(payload.slots.map((entry) => entry.slot).sort(), slots);
  assert.ok(payload.slots.every((entry) => entry.registered === true), JSON.stringify(payload.slots));
});

test("单个插槽注册失败时不影响其它插槽", async () => {
  const module = loadModule();
  const mod = module.factory(() => ReactStub);
  const { ctx, registrations } = makeCtx();
  const original = ctx.slots.register;
  ctx.slots.register = (options, component) => {
    if (options.name === "conversation.input.model.label") throw new Error("slot is occupied");
    return original(options, component);
  };

  assert.doesNotThrow(() => mod.apply(ctx));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const slots = registrations.map((entry) => entry.slot).sort();
  assert.deepEqual(slots, ["conversation.input.left", "settings.plugins.tab"]);
});

test("重复注册 locale 不抛异常（降级为内置文案）", () => {
  const module = loadModule();
  const mod = module.factory(() => ReactStub);
  const { ctx } = makeCtx();
  ctx.locale.register = () => { throw new Error("duplicate (ns, locale)"); };
  assert.doesNotThrow(() => mod.apply(ctx));
});
