import assert from "node:assert/strict";
import test from "node:test";

import { corsHeadersFor, isLocalOrigin } from "../lib/cors.mjs";

test("local origins are allowed", () => {
  for (const origin of [
    "null",
    "file://",
    "file:///C:/app/index.html",
    "app://hermes",
    "http://127.0.0.1:3000",
    "http://localhost:60788",
    "https://localhost",
  ]) {
    assert.equal(isLocalOrigin(origin), true, origin);
    assert.equal(corsHeadersFor(origin)["Access-Control-Allow-Origin"], origin);
  }
});

test("remote origins get no CORS headers", () => {
  for (const origin of ["https://evil.example", "http://192.168.1.10:8080", "null-but-not", ""]) {
    assert.equal(isLocalOrigin(origin), false, origin);
    assert.deepEqual(corsHeadersFor(origin), {});
  }
});

test("missing origin (non-browser client) gets no headers but is not rejected", () => {
  assert.deepEqual(corsHeadersFor(undefined), {});
});

test("allowed headers include x-api-key for anthropic-style clients", () => {
  const headers = corsHeadersFor("http://127.0.0.1:1");
  assert.match(headers["Access-Control-Allow-Headers"], /X-Api-Key/i);
  assert.equal(headers.Vary, "Origin");
});
