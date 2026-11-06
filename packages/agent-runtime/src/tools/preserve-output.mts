import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { ToolOutputStore } from "./output-store.mts";

/** A single entry boundary for custom tool text. Pi shell/read tools already
 * manage their own previews. Preserve complete JSON as an artifact, never cut
 * serialized JSON into an invalid tool result or rewrite earlier history.
 */
export function preserveToolOutput(
  tool: AgentTool<any, any>,
  store: ToolOutputStore,
): AgentTool<any, any> {
  if (tool.name === "exec_command" || tool.name === "read_file") return tool;
  return {
    ...tool,
    execute: async (...args) => {
      const result = await tool.execute(...args);
      return preserveResult(result, store);
    },
  };
}

export async function preserveResult(
  result: AgentToolResult<any>,
  store: ToolOutputStore,
) {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  if (!truncateHead(text).truncated) return result;
  let full = text;
  let extension: "txt" | "json" = "txt";
  try {
    full = JSON.stringify(JSON.parse(text), null, 2);
    extension = "json";
  } catch {}
  let artifact;
  try {
    artifact = await store.write(full, extension);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Execution may already have mutated the circuit. Never replace its
    // outcome with a storage exception or prompt a repeat of that operation.
    return {
      ...result,
      content: [
        {
          type: "text" as const,
          text: `完整输出保存失败：${message}。操作已经执行，以下保留原始结果；不要仅因保存失败重复执行操作。`,
        },
        ...result.content,
      ],
      details: { ...result.details, outputPersistenceError: message },
    };
  }
  const envelope = JSON.stringify({
    truncated: true,
    fullOutput: artifact,
    preview: truncateHead(full).content,
    continuation: { tool: "read_file", path: artifact.path, offset: 1 },
  });
  let replaced = false;
  return {
    ...result,
    content: result.content.flatMap<AgentToolResult<any>["content"][number]>(
      (part) => {
        if (part.type !== "text") return [part];
        if (replaced) return [];
        replaced = true;
        return [{ type: "text" as const, text: envelope }];
      },
    ),
    details: {
      ...result.details,
      outputArtifacts: [...(result.details?.outputArtifacts || []), artifact],
    },
  };
}
