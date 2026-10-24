import type { ServiceConfig, ServiceSelection } from "./types.mts";
import type { RuntimeMessage } from "../conversations/types.mts";
// Conversation-owned settings contain no credentials. Credentials stay in the
// provider store and are resolved only after the endpoint/protocol matches.
const endpoint = (value: any) => String(value || "").replace(/\/+$/, "");
function selectionFor(config: ServiceConfig | null): ServiceSelection | null {
  return config
    ? {
        serviceId: config.id,
        baseUrl: endpoint(config.baseUrl),
        api: config.api,
        model: config.model,
        effort: config.effort,
        vision: config.vision === true,
        contextWindow: config.contextWindow,
      }
    : null;
}
function sameService(a: any, b: any) {
  return Boolean(
    a && b && endpoint(a.baseUrl) === endpoint(b.baseUrl) && a.api === b.api,
  );
}
function configurationIssue(selection: any, config: any, hasHistory: any) {
  if (!selection && hasHistory)
    return {
      code: "unbound-history",
      message: "这条会话的模型服务记录缺失。选择服务后再继续。",
    };
  if (selection && !sameService(selection, config))
    return {
      code: "service-missing",
      message: `原模型服务不可用：${selection.baseUrl}`,
    };
  return null;
}
function recoverHistory(history: RuntimeMessage[]): RuntimeMessage[] {
  return history.map((m: any) =>
    m.type === "turn" && m.status === "running"
      ? {
          ...m,
          status: "interrupted",
          error: "应用在回答结束前退出，已有内容已保留。",
          elapsedMs: m.elapsedMs || 0,
        }
      : m.type === "activity" && m.status === "running"
        ? {
            ...m,
            status: "warning",
            resultStatus: "unknown",
            detail: [
              m.detail,
              "应用在调用结束前退出，结果未知，请先检查工作区。",
            ]
              .filter(Boolean)
              .join("\n"),
          }
        : m,
  );
}
export { selectionFor, sameService, configurationIssue, recoverHistory };
