/**
 * The circuit tools as pi-agent-core AgentTools. One generic wrapper turns
 * each handler into a tool: it checks the turn is still current, catches
 * every failure into a readable error payload and splits images out of the
 * JSON text (or replaces them with a notice when the model has no vision).
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { ERROR_SCHEMA, toolErrorFromException } from "./errors.mts";
import { splitModelContent } from "./output.mts";
import { TOOL_SPECS, type ToolName } from "./schemas.mts";
import { arrangeCircuit } from "./arrange.mts";
import {
  createCircuit,
  defineCircuit,
  openCircuit,
  undoEdit,
} from "./documents.mts";
import {
  connect,
  deleteObjects,
  moveComponents,
  placeComponent,
  setAttributes,
} from "./edit.mts";
import {
  describeComponent,
  inspectCircuit,
  renderCircuit,
} from "./inspect.mts";
import { readObservation } from "./observations.mts";
import { simulateCircuit, traceCircuit } from "./verify.mts";
import type { ToolContext } from "./context.mts";

export type ToolHandler = (
  context: ToolContext,
  args: Record<string, any>,
) => Promise<Record<string, unknown>>;

export const HANDLERS: Record<ToolName, ToolHandler> = {
  open_circuit: openCircuit,
  create_circuit: createCircuit,
  define_circuit: defineCircuit,
  inspect_circuit: inspectCircuit,
  render_circuit: renderCircuit,
  describe_component: describeComponent,
  place_component: placeComponent,
  set_attributes: setAttributes,
  connect,
  move_components: moveComponents,
  delete_objects: deleteObjects,
  arrange_circuit: arrangeCircuit,
  simulate_circuit: simulateCircuit,
  trace_circuit: traceCircuit,
  undo_edit: undoEdit,
  read_observation: readObservation,
};

/** Labels the conversation shows per tool name (file tools included). */
export const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  list_files: "列出文件",
  exec_command: "执行命令",
  ...Object.fromEntries(
    Object.values(TOOL_SPECS).map((s) => [s.name, s.label]),
  ),
};

export function circuitTools({
  context,
  vision,
}: {
  context: ToolContext;
  vision: boolean;
}): AgentTool<any, any>[] {
  return Object.values(TOOL_SPECS).map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as any,
    execute: async (
      _callId: string,
      args: any,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      try {
        context.assertCurrent();
        signal?.throwIfAborted();
        const value = await HANDLERS[spec.name](context, args ?? {});
        context.assertCurrent();
        const { publicResult, modelContentItems } = splitModelContent(value);
        return {
          content: [
            { type: "text", text: JSON.stringify(publicResult) },
            ...modelContentItems.map((item: any) =>
              vision
                ? {
                    type: "image" as const,
                    data: item.imageData,
                    mimeType: item.mimeType,
                  }
                : {
                    type: "text" as const,
                    text: "工具返回了图片；当前模型服务未启用图片输入，不能声称已看图。",
                  },
            ),
          ],
          details: null,
        };
      } catch (error) {
        const failure = toolErrorFromException(spec.name, error);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: { ...failure.toolError, schema: ERROR_SCHEMA },
              }),
            },
          ],
          details: null,
          isError: true,
        };
      }
    },
  }));
}
