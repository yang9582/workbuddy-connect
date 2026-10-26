/**
 * 模型行的对外视图（只保留 UI / provider 需要的字段）。
 *
 * 上游模型目录里 `reasoning` 是权威的"推理档位声明"：
 *   { supports, onlyReasoning, supportedEfforts: ["low","high","max"], defaultEffort, canDisableThinking }
 * 官方插件就是按它显示档位的；用发请求试探代替它会漏掉整批模型。
 */

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function sanitizeReasoning(value) {
  if (value === null || typeof value !== "object" || value.supports !== true) return null;
  const supported = Array.isArray(value.supportedEfforts)
    ? value.supportedEfforts.filter((effort) => typeof effort === "string" && EFFORTS.has(effort))
    : [];
  return {
    supports: true,
    onlyReasoning: value.onlyReasoning === true,
    canDisableThinking: value.canDisableThinking === true,
    defaultEffort: typeof value.defaultEffort === "string" && EFFORTS.has(value.defaultEffort) ? value.defaultEffort : null,
    supportedEfforts: supported,
  };
}
