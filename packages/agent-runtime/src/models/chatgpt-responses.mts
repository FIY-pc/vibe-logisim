import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Stream } from "openai/core/streaming";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { ServiceConfig, ServiceSelection } from "./types.mts";

/** Encrypted checkpoints belong to one account, endpoint and model. */
export function chatgptContextScope(
  config: Pick<ServiceConfig, "id" | "auth" | "baseUrl" | "model"> | null,
  selection?: ServiceSelection | null,
) {
  if (config?.auth !== "chatgpt") return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.id,
        config.baseUrl,
        selection?.model ?? config.model,
      ]),
    )
    .digest("hex");
}

/** This account uses native Responses IDs even though its provider key is scoped. */
export function chatgptInput(model: Model<any>, messages: AgentMessage[]) {
  return convertResponsesMessages(
    model,
    { messages } as any,
    new Set([model.provider]),
    { supportsMidConvoSystemMessages: false },
  );
}

/** Prepend the canonical server prefix to the converted recent messages. */
export function compactedChatGPTInput(
  input: any[],
  checkpoint:
    { through: number; output: Record<string, unknown>[] } | undefined,
) {
  if (!checkpoint) return input;
  const system = input[0]?.role === "developer" ? [input[0]] : [];
  return [...system, ...checkpoint.output, ...input.slice(system.length)];
}

/** Observe official SSE items without replacing Pi's transport or agent loop.
 * The SDK parser handles framing and UTF-8. Only a completed response is eligible
 * for installation; the caller commits it together with the assistant message.
 */
export function observeChatGPTCompaction(
  request: typeof fetch,
  observer: {
    started(): void;
    completed(output: Record<string, unknown>[]): void;
  },
): typeof fetch {
  return async (input, init) => {
    const response = await request(input, init);
    if (!response.ok || !response.body) return response;
    const controller = new AbortController();
    const events = Stream.fromSSEResponse<any>(response, controller)[
      Symbol.asyncIterator
    ]();
    const encoder = new TextEncoder();
    let output: Record<string, any>[] = [];
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const next = await events.next();
          if (next.done) {
            target.close();
            return;
          }
          const event = next.value;
          if (event.type === "response.output_item.done") {
            output.push(event.item);
            if (event.item.type === "compaction") observer.started();
          }
          if (event.type === "response.completed") {
            // Some subscription streams leave response.output empty and deliver
            // the canonical items solely via output_item.done.
            if (!output.length) output = event.response.output || [];
            const index = output.findLastIndex(
              (item) =>
                item.type === "compaction" &&
                typeof item.encrypted_content === "string" &&
                item.encrypted_content.length,
            );
            if (index >= 0) observer.completed(output.slice(index));
          }
          target.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        } catch (error) {
          target.error(error);
        }
      },
      async cancel() {
        controller.abort();
        await events.return?.();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Adapt the existing Responses transport to the ChatGPT plan route. */
export function chatgptPayload(payload: any) {
  const next = { ...payload, store: false, stream: true };
  for (const field of [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "prompt_cache_options",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ])
    delete next[field];
  next.input = next.input.map((item: any) => {
    if (item.role === "system") return { ...item, role: "developer" };
    if (["function_call", "custom_tool_call"].includes(item.type))
      return { ...item, namespace: "vibe_logisim" };
    return item;
  });
  if (next.tools?.length)
    next.tools = [
      {
        type: "namespace",
        name: "vibe_logisim",
        description: "Circuit workspace and file tools",
        tools: next.tools,
      },
    ];
  return next;
}

export function chatgptFetch(
  api: string,
  access: () => Promise<string>,
  request: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== `${api}/responses`) throw new Error("ChatGPT 请求地址无效");
    const headers = new Headers(
      init?.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${await access()}`);
    if (init?.signal?.aborted) throw init.signal.reason;
    return request(input, { ...init, headers, redirect: "error" });
  };
}
