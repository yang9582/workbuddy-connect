/**
 * 从 ~/.dsh/.env（DSH 插件使用的同一份文件）加载 WORKBUDDY* 变量，
 * 让桥接以与 DSH 插件完全相同的方式定位 WorkBuddy 的 Electron 二进制
 * （加密凭据解密需要用它）。真实环境变量优先，不被覆盖。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadDshEnv() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  const envPath = join(dshHome, ".env");
  if (!existsSync(envPath)) return;
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (!key.startsWith("WORKBUDDY")) continue;
    if (process.env[key] !== undefined) continue; // 已存在的真实环境变量优先
    let value = rawValue.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted !== null) value = quoted[2];
    process.env[key] = value;
  }
}
