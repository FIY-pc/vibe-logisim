import type { ServiceConfig } from "./types.mts";

type Configuration = Pick<ServiceConfig, "api" | "maxOutput">;
type Metadata = { maxOutput?: number | null } | null;

/** Only an explicit setting or advertised model capability supplies a cap. */
export function outputLimit(config: Configuration, metadata: Metadata = null) {
  return config.maxOutput ?? metadata?.maxOutput ?? undefined;
}

/** Pi supplies a numeric default even when the wire protocol permits omission. */
export function generationPayload(
  config: Configuration,
  metadata: Metadata = null,
) {
  const limit = outputLimit(config, metadata);
  if (config.api === "anthropic-messages" && limit === undefined)
    throw new Error(
      "此 Messages 接口要求最大输出 token，但模型目录没有这个模型的上限。请在 AI 设置的高级设置中填写服务支持的最大输出 token。",
    );
  return (payload: any) => {
    if (limit !== undefined) return payload;
    const next = { ...payload };
    delete next.max_tokens;
    delete next.max_completion_tokens;
    delete next.max_output_tokens;
    return next;
  };
}
