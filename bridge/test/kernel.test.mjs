import assert from "node:assert/strict";
import test from "node:test";

import {
  KERNEL_META,
  KernelContractError,
  assertKernelExports,
  describeKernel,
  kernelDigest,
  missingExports,
} from "../lib/kernel.mjs";

test("内核文件与 kernel.json 记录一致", () => {
  const info = describeKernel();
  assert.equal(info.matchesRecord, true, info.warning ?? "");
  assert.equal(info.version, "0.7.9");
  assert.equal(kernelDigest(), KERNEL_META.sha256);
});

test("missingExports: 全部存在时为空", () => {
  const full = Object.fromEntries(Object.values(KERNEL_META.exports).map((alias) => [alias, () => {}]));
  assert.deepEqual(missingExports(full), []);
});

test("missingExports: 能报出缺失的语义名", () => {
  const partial = { [KERNEL_META.exports.WorkBuddyUpstreamClient]: class {} };
  const missing = missingExports(partial);
  assert.equal(missing.includes("WorkBuddyCredentialStore"), true);
  assert.equal(missing.includes("WorkBuddyUpstreamClient"), false);
});

test("assertKernelExports: 缺导出时抛出可读的 KernelContractError", () => {
  assert.throws(
    () => assertKernelExports({}),
    (error) => {
      assert.equal(error instanceof KernelContractError, true);
      assert.match(error.message, /内核契约不匹配/);
      assert.match(error.message, /kernel --refresh/);
      assert.match(error.message, /0\.7\.9/);
      return true;
    },
  );
});

test("assertKernelExports: 完整命名空间不抛错", () => {
  const full = Object.fromEntries(Object.values(KERNEL_META.exports).map((alias) => [alias, 1]));
  assert.doesNotThrow(() => assertKernelExports(full));
});
