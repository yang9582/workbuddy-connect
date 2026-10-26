/**
 * CORS：只对"本地页面"回发跨域头。
 *
 * 之前是 `Access-Control-Allow-Origin: *`，任意网页都能读取本地桥接的响应
 * （前提是拿到令牌）。现在只对 file:// / app:// / null（Electron 渲染进程）
 * 与 localhost / 127.0.0.1 的来源回发；其他来源不回 CORS 头，浏览器就读不到响应。
 *
 * 非浏览器客户端（curl、pi-ai、Hermes 后端）不带 Origin，本来不需要 CORS。
 */
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLocalOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return false;
  if (origin === "null" || origin === "file://") return true;
  if (origin.startsWith("file://") || origin.startsWith("app://")) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** @returns {Record<string,string>} 需要写进响应的头（非本地来源返回空对象） */
export function corsHeadersFor(origin) {
  if (!isLocalOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
