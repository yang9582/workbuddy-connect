import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeReasoning } from "../lib/model-view.mjs";

test("keeps declared efforts in order", () => {
  const reasoning = sanitizeReasoning({
    supports: true, onlyReasoning: true, defaultEffort: "max",
    supportedEfforts: ["low", "high", "max"], canDisableThinking: false,
  });
  assert.deepEqual(reasoning.supportedEfforts, ["low", "high", "max"]);
  assert.equal(reasoning.defaultEffort, "max");
});

test("drops unknown effort names and unknown defaults", () => {
  const reasoning = sanitizeReasoning({
    supports: true, supportedEfforts: ["low", "banana", "high"], defaultEffort: "banana",
  });
  assert.deepEqual(reasoning.supportedEfforts, ["low", "high"]);
  assert.equal(reasoning.defaultEffort, null);
});

test("models without declared efforts keep an empty list", () => {
  const reasoning = sanitizeReasoning({ supports: true, onlyReasoning: true, defaultEffort: "high" });
  assert.deepEqual(reasoning.supportedEfforts, []);
  assert.equal(reasoning.defaultEffort, "high");
});

test("null / unsupported / malformed input returns null", () => {
  assert.equal(sanitizeReasoning(null), null);
  assert.equal(sanitizeReasoning(undefined), null);
  assert.equal(sanitizeReasoning({ supports: false }), null);
  assert.equal(sanitizeReasoning("nope"), null);
});
