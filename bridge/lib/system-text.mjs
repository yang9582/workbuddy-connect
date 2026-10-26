/** system 文本的纯函数工具（从 server.mjs 抽出，便于单测与复用）。 */

/** Claude Code 会在 system prompt 顶部塞 x-anthropic-billing-header（cc_version/cc_entrypoint），
 *  WorkBuddy 上游把它当作"非官方渠道"拒绝（11128）。转发前剥掉这类标记行。 */
export function sanitizeSystemText(text) {
  if (typeof text !== "string" || text === "") return "";
  return text
    .split("\n")
    .filter((line) => !/^\s*x-anthropic-billing-header\s*:/i.test(line))
    .join("\n")
    .trim();
}
