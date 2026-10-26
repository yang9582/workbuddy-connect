/**
 * 内核契约守卫。
 *
 * 桥接依赖的 `vendor/host-bundle.js` 是 dsh-workbuddy-connect 的**打包产物**：
 * 公开名字是压缩后的单字母别名（`O`、`m`……），上游一次构建就可能改变。
 * 直接把别名 import 进 server.mjs 的后果是：缺一个导出就在 import 期抛
 * `SyntaxError`，看不出是"内核版本不匹配"。
 *
 * 这里做三件事：
 *   1. 只在这一处接触单字母别名；
 *   2. 缺导出时抛出可读的 KernelContractError（带版本、哈希、修复命令）；
 *   3. 文件与 kernel.json 记录不一致时给出告警（而非直接失败——升级内核是允许的）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as namespace from "../vendor/host-bundle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KERNEL_PATH = join(HERE, "..", "vendor", "host-bundle.js");

export const KERNEL_META = JSON.parse(readFileSync(join(HERE, "..", "kernel.json"), "utf8"));

export class KernelContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "KernelContractError";
  }
}

/** 计算内核文件的 sha256（供守卫与 `wbconnect kernel --refresh` 对照）。 */
export function kernelDigest() {
  return createHash("sha256").update(readFileSync(KERNEL_PATH)).digest("hex");
}

/** 语义名 → 内核里实际存在的导出名。 */
function aliasOf(semantic) {
  return KERNEL_META.exports[semantic];
}

/** 返回缺失的语义名列表；`ns` 可注入，便于测试。 */
export function missingExports(ns, meta = KERNEL_META) {
  return Object.keys(meta.exports ?? {}).filter((semantic) => ns[meta.exports[semantic]] === undefined);
}

/** 契约断言：缺失导出时抛出带修复指引的错误。 */
export function assertKernelExports(ns, meta = KERNEL_META) {
  const missing = missingExports(ns, meta);
  if (missing.length === 0) return;
  const actual = kernelDigest().slice(0, 16);
  const expected = String(meta.sha256 ?? "?");
  throw new KernelContractError(
    [
      `WorkBuddy 内核契约不匹配：vendor/host-bundle.js 缺少 ${missing.length} 个导出（${missing.join("、")}）。`,
      `kernel.json 记录：${meta.source} ${meta.version}，sha256 ${expected.slice(0, 16)}…`,
      `实际文件：sha256 ${actual}…`,
      "这意味着内核被打包成了另一版布局，桥接无法安全启动。",
      "修复：运行 `python -m workbuddy.cli_main kernel --refresh` 重新提取内核并刷新 kernel.json，",
      "或把 bridge/vendor/host-bundle.js 换回 kernel.json 记录的版本。",
    ].join("\n"),
  );
}

assertKernelExports(namespace);

const pick = (semantic) => namespace[aliasOf(semantic)];

export const WorkBuddyUpstreamClient = pick("WorkBuddyUpstreamClient");
export const WorkBuddyCredentialStore = pick("WorkBuddyCredentialStore");
export const atRestKeyProviderFor = pick("atRestKeyProviderFor");
export const CN_VARIANT = pick("CN_VARIANT");
export const AI_VARIANT = pick("AI_VARIANT");
export const variantFor = pick("variantFor");
export const prepareChatBody = pick("prepareChatBody");
export const modelWithCurrentPromotion = pick("modelWithCurrentPromotion");
export const normalizeCredits = pick("normalizeCredits");
export const FALLBACK_WORKBUDDY_MODELS = pick("FALLBACK_WORKBUDDY_MODELS");
export const FALLBACK_WORKBUDDY_AI_MODELS = pick("FALLBACK_WORKBUDDY_AI_MODELS");

/** 启动时自检：哈希不一致只告警（升级内核是合法操作），但仍提示需要刷新记录。 */
export function describeKernel() {
  const actual = kernelDigest();
  const expected = String(KERNEL_META.sha256 ?? "");
  const matches = actual === expected;
  return {
    source: KERNEL_META.source,
    version: KERNEL_META.version,
    sha256: actual,
    matchesRecord: matches,
    warning: matches
      ? null
      : `内核文件与 kernel.json 记录不一致（记录 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）。`
        + "若刚升级过内核，请运行 `python -m workbuddy.cli_main kernel --refresh` 更新记录。",
  };
}
