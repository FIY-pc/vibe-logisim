/** The model's view of a tool result: one location per duplicate, no host paths. */
import { readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CircuitToolError } from "./errors.mts";

export const MODEL_OUTPUT_SCHEMA = "vibe-logisim.canonical-model-view/v1";
const RESULT_SCHEMA = "vibe-logisim.circuit-plugin.result/v1";

// Tools that return the result envelope repeat its binding and run metadata.
const BOUND_TOOLS = new Set([
  "trace_circuit",
  "evaluate_circuit",
  "render_circuit",
  "compare_circuit",
  "run_verification",
]);
// Fixed JSON Pointers [duplicate, canonical]; a duplicate is removed only when
// it deep-equals its canonical value in the same result.
const BOUND_DUPLICATES: [string, string][] = [
  ["/result/binding", "/binding"],
  ["/runtimeProfile", "/binding/runtimeProfile"],
  ["/result/runtimeProfile", "/binding/runtimeProfile"],
  ...[
    "runtimeProfileId",
    "artifactSha256",
    "revisionId",
    "circuit",
    "candidateId",
  ].flatMap((key): [string, string][] => [
    [`/${key}`, `/binding/${key}`],
    [`/result/${key}`, `/binding/${key}`],
    [`/session/${key}`, `/binding/${key}`],
  ]),
  ["/invocation/projectId", "/binding/projectId"],
  ["/invocation/revisionId", "/binding/revisionId"],
  ["/run/runtimeProfileId", "/binding/runtimeProfileId"],
  ["/result/schema", "/schema"],
  ["/result/plugin", "/plugin"],
  ["/result/run", "/run"],
  ["/result/runId", "/run/id"],
  ["/result/stimulusSha256", "/run/stimulusSha256"],
  ["/result/authority", "/run/authority"],
  ["/session/mode", "/run/mode"],
  ["/session/authority", "/run/authority"],
];
// Host paths of native artifacts never reach the model.
const HOST_PATH_KEYS = new Set([
  "artifactPath",
  "jarPath",
  "stateRoot",
  "runtimePath",
]);

function at(value: any, pointer: string) {
  for (const key of pointer.slice(1).split("/")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = value[key];
  }
  return value;
}
function parent(value: any, pointer: string) {
  const keys = pointer.slice(1).split("/");
  const key = keys.pop()!;
  for (const part of keys) value = value[part];
  return { value, key };
}

export function projectModelResult(result: any) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.hasOwn(result, "modelProjection") ||
    result.error != null
  )
    return result;
  const tool = result.invocation?.tool;
  if (!(result.schema === RESULT_SCHEMA && BOUND_TOOLS.has(tool)))
    return !Object.hasOwn(result, "schema") && tool === "inspect_circuit"
      ? projectInspection(result)
      : result;
  let projected: any;
  for (const [destination, source] of BOUND_DUPLICATES) {
    const original = at(result, destination),
      canonical = at(result, source);
    // Nulls (including unknown observations) and absent fields stay verbatim.
    if (original == null || !isDeepStrictEqual(original, canonical)) continue;
    projected ||= structuredClone(result);
    const target = parent(projected, destination);
    delete target.value[target.key];
  }
  return projected || result;
}

function projectInspection(result: any) {
  const template = result.objectReferenceTemplate;
  // Ambiguous templates or IDs that would need another escaping rule stay intact.
  if (
    typeof template !== "string" ||
    !template.startsWith("circuit://object?") ||
    template.split("COMPONENT_ID").length !== 2 ||
    !/[?&]componentId=COMPONENT_ID(?:&|$)/.test(template) ||
    !Array.isArray(result.components)
  )
    return result;
  let projected: any;
  result.components.forEach((component: any, index: number) => {
    if (
      !component ||
      typeof component.componentId !== "string" ||
      !/^[A-Za-z0-9._~-]+$/.test(component.componentId) ||
      typeof component.reference !== "string" ||
      component.reference !==
        template.replace("COMPONENT_ID", component.componentId)
    )
      return;
    projected ||= structuredClone(result);
    delete projected.components[index].reference;
  });
  return projected || result;
}

// A leaked host path starts at a real top-level directory; JSON pointers and
// other slash-led identifiers do not.
let roots: Set<string> | null = null;
const absolute = (value: string) => {
  if (/^[A-Za-z]:\\/.test(value)) return true;
  const first = /^\/([^/\s]+)\//.exec(value)?.[1];
  if (!first) return false;
  roots ||= new Set(readdirSync("/"));
  return roots.has(first);
};
const under = (value: string, root: string) => {
  const relative = path.relative(root, value);
  return (
    !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/**
 * Removes host-path keys, then refuses any remaining absolute path outside the
 * model's cwd. A refused result fails the call instead of being trimmed.
 */
export function scrubModelResult(value: unknown, modelCwd: string | null) {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !HOST_PATH_KEYS.has(key))
          .map(([key, item]) => [key, visit(item)]),
      );
    if (
      typeof node === "string" &&
      absolute(node) &&
      !(modelCwd && under(node, modelCwd))
    )
      throw new CircuitToolError("TOOL_FAILED", "结果包含工作区外路径", {
        hint: "不要依赖该结果中的路径；检查当前工作区后再决定是否重试。",
      });
    return node;
  };
  return visit(value);
}
