#!/usr/bin/env node
/** 诊断脚本：验证桥接内核（凭据读取/解密、token、模型目录、积分）。绝不打印令牌内容。 */
import {
  O as WorkBuddyUpstreamClient,
  m as WorkBuddyCredentialStore,
  b as atRestKeyProviderFor,
  S as CN_VARIANT,
  w as variantFor,
} from "./vendor/host-bundle.js";
import { loadDshEnv } from "./lib/dsh-env.mjs";

loadDshEnv();

const variant = variantFor(process.argv[2] ?? "workbuddy") ?? CN_VARIANT;
const client = new WorkBuddyUpstreamClient();
const store = new WorkBuddyCredentialStore({
  variant,
  refresh: (credential) => client.refreshToken(credential),
  keyProvider: atRestKeyProviderFor(variant),
});

console.log("variant:", variant.id, `(${variant.displayName})`);
console.log("desktop auth path:", store.desktopAuthPath());
console.log("desktop file present:", await store.desktopFilePresent());
console.log("desktop auth format:", await store.desktopAuthFormat());
console.log("sign-in status:", JSON.stringify(await store.status()));

try {
  const credential = await store.resolve();
  console.log(
    "credential resolved: source=%s expiresAt=%s uid=%s domain=%s",
    credential.source,
    new Date(credential.expiresAtMs).toISOString(),
    credential.uid === "" ? "(empty)" : "(set)",
    credential.domain === "" ? "(empty)" : credential.domain,
  );
  const models = await client.fetchModels(credential);
  console.log("models fetched:", models.length);
  console.log("first three:", models.slice(0, 3).map((m) => `${m.id} ctx=${m.contextWindow} max=${m.maxTokens}`).join(" | "));
  const credits = await client.fetchCredits(credential);
  console.log("credits total:", credits.total, credits.unlimited === true ? "(unlimited)" : "");
} catch (error) {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
