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
