"use strict";

class AgentModelError extends Error {
  constructor(code, message, {retryable = false, phase = "catalog", model = null, cause = null} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = "AgentModelError";
    this.code = code;
    this.retryable = retryable;
    this.phase = phase;
    this.model = model;
  }

  asJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      phase: this.phase,
      ...(this.model ? {model: this.model} : {}),
    };
  }
}

function classifyModelError(error, {phase = "catalog", model = null} = {}) {
  if (error instanceof AgentModelError) return error;
  const message = String(error?.message || error || "未知模型错误");
  const lower = message.toLowerCase();
  const status = Number(error?.status || error?.code);
  const auth = status === 401 || status === 403 || /unauthori[sz]ed|authentication|login required|auth required|登录/.test(lower);
  const missing = status === 404 || /model[^\n]*(?:does not exist|not found|no access|unavailable)|(?:does not exist|not found|no access)[^\n]*model|模型[^\n]*(?:不存在|不可用|无权)/.test(lower);
  const transient = /timeout|timed out|econn|network|temporar|503|502|连接|网络|超时/.test(lower);

  if (phase === "turn" && !auth && !missing && !transient) return null;
  if (auth) {
    return new AgentModelError("MODEL_AUTH_REQUIRED", "模型服务需要重新登录或认证已失效。请检查本机 Codex 登录状态。", {
      retryable: false, phase, model, cause: error,
    });
  }
  if (missing) {
    const shown = model ? `「${model}」` : "当前配置的模型";
    return new AgentModelError(
      phase === "catalog" ? "MODEL_CATALOG_UNAVAILABLE" : "MODEL_UNAVAILABLE",
      phase === "catalog"
        ? "当前连接没有可用的模型目录，请检查 provider 配置后刷新。"
        : `${shown} 不可用或当前账户无权使用，请打开模型列表并选择当前连接支持的模型。`,
      {retryable: false, phase, model, cause: error},
    );
  }
  if (transient || phase === "catalog") {
    return new AgentModelError(
      "MODEL_CATALOG_UNAVAILABLE",
      `暂时无法读取当前连接的模型目录：${message}`,
      {retryable: true, phase, model, cause: error},
    );
  }
  return new AgentModelError("MODEL_REQUEST_FAILED", `模型请求失败：${message}`, {
    retryable: false, phase, model, cause: error,
  });
}

module.exports = {AgentModelError, classifyModelError};
