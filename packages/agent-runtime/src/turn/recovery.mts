import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

/** One budget per model step; HTTP transports must not retry underneath it. */
export const RETRY_POLICY = {
  maxRetries: 6,
  baseDelayMs: 2000,
  maxAgentDelayMs: 30_000,
};
export type RetryPolicy = typeof RETRY_POLICY;

// Known configuration/account errors take precedence over a generic 429/5xx.
const AUTH_ERROR =
  /\b401\b|unauthori[sz]ed|invalid.*(api[ _-]?key|token)|incorrect api key|authentication/i;
const SETTINGS: [RegExp, string][] = [
  [
    /subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded/,
    "ChatGPT 使用额度已达上限，请检查用量或切换服务",
  ],
  [
    /subscription_sharing_(user_not_eligible|unsupported_capability|route_not_supported|invalid_user)|chatpass_v2_/,
    "当前账号或服务不支持这次请求，请检查 AI 设置",
  ],
  [
    /insufficient_quota|quota.?exceeded|out of budget|billing|monthly usage limit|available balance|GoUsageLimitError|FreeUsageLimitError|额度不足|额度.*上限|余额不足/i,
    "模型服务额度不足，请检查额度或切换服务",
  ],
  [AUTH_ERROR, "模型服务拒绝了 API 密钥，请检查 AI 设置"],
  [
    /\b403\b|forbidden|permission denied/i,
    "模型服务拒绝了这次请求，请检查账号权限",
  ],
  [
    /\b404\b|does not exist|not found|no such model|unknown model/i,
    "模型服务找不到这个模型或接口，请检查 AI 设置",
  ],
];
const TEMPORARY: [RegExp, string][] = [
  [/timed? ?out|timeout|ETIMEDOUT/i, "模型服务响应超时"],
  [
    /terminated|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|connection|stream.*(ended|closed|interrupted|disconnected)/i,
    "与模型服务的连接中断",
  ],
  [/\b429\b|rate.?limit|too many requests|请求过于频繁/i, "模型服务暂时限流"],
  [
    /overloaded|\b5\d\d\b|service unavailable|bad gateway|server error|服务繁忙|系统繁忙/i,
    "模型服务暂时不可用",
  ],
];

export function modelFailure(message: string, chatgpt = false) {
  const setting = SETTINGS.find(([pattern]) => pattern.test(message));
  const retryable =
    !setting &&
    (isRetryableAssistantError({
      stopReason: "error",
      errorMessage: message,
    } as AssistantMessage) ||
      /服务繁忙|系统繁忙|请求过于频繁/.test(message));
  const badRequest =
    !retryable && /\b400\b|invalid_request|bad request/i.test(message);
  const reason =
    chatgpt && setting?.[0] === AUTH_ERROR
      ? "ChatGPT 登录未被接受，请在 AI 设置中重新登录"
      : setting?.[1] ||
        TEMPORARY.find(([pattern]) => pattern.test(message))?.[1] ||
        (badRequest
          ? "模型服务不接受这次请求，请检查设置或调整消息"
          : "回答未能完成");
  return {
    retryable,
    action:
      setting || badRequest ? ("settings" as const) : ("continue" as const),
    reason,
    message: /[\u4e00-\u9fff]/.test(message)
      ? message
      : `${reason}（${message}）`,
  };
}
