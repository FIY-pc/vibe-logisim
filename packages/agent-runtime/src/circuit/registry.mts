/** The circuit tool catalog: manifest checks, model-visible specs and signature. */
import { createHash } from "node:crypto";

export const CONTRACT = Object.freeze({
  id: "vibe-logisim.circuit",
  schema: "vibe-logisim.circuit-plugin/v1",
  resultSchema: "vibe-logisim.circuit-plugin.result/v1",
});
export interface ManifestTool {
  type: "function";
  name: string;
  label?: string;
  description: string;
  category?: string;
  owner: "studio" | "host";
  exposure: "direct" | "hidden";
  sourceMutation?: boolean;
  candidate?: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    [key: string]: unknown;
  };
}
export interface Manifest {
  id: string;
  schema: string;
  resultSchema: string;
  version: string;
  workflow?: string;
  tools: ManifestTool[];
  [key: string]: unknown;
}
export interface ModelTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: ManifestTool["inputSchema"];
}

const invalid = (detail: string) => new Error("电路插件协议不匹配：" + detail);
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
function freeze<T>(value: T): T {
  if (object(value) || Array.isArray(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name);

function range(schema: Record<string, any>, minimum: string, maximum: string) {
  const low = schema[minimum],
    high = schema[maximum];
  if (low !== undefined && high !== undefined) return `${low}..${high}`;
  if (low !== undefined) return `>=${low}`;
  if (high !== undefined) return `<=${high}`;
  return "";
}

// Code Mode's number and array declarations omit JSON Schema bounds. The
// executable schema stays untouched; the missing facts go into the
// description, which survives native rendering even for nested items.
export function schemaConstraints(schema: unknown) {
  const groups = new Map<string, string[]>();
  const visit = (node: unknown, path: string) => {
    if (!object(node)) return;
    const rules: string[] = [];
    const numeric = range(node, "minimum", "maximum");
    if (node.type === "integer")
      rules.push(["integer", numeric].filter(Boolean).join(" "));
    else if (numeric) rules.push(numeric);
    if (node.multipleOf !== undefined)
      rules.push(`multiple of ${node.multipleOf}`);
    for (const [low, high, unit] of [
      ["minItems", "maxItems", "items"],
      ["minLength", "maxLength", "characters"],
      ["minProperties", "maxProperties", "properties"],
    ]) {
      const bound = range(node, low, high);
      if (bound) rules.push(`${bound} ${unit}`);
    }
    if (rules.length) {
      const rule = rules.join(", ");
      if (!groups.has(rule)) groups.set(rule, []);
      groups.get(rule)!.push(path || "arguments");
    }
    for (const name of Object.keys(node.properties || {}).sort()) {
      // Brackets keep unusual property names unambiguous; catalog names use dots.
      const field = /^[A-Za-z_$][\w$]*$/.test(name)
        ? (path ? "." : "") + name
        : `[${JSON.stringify(name)}]`;
      visit(node.properties[name], path + field);
    }
    visit(node.items, path + "[]");
    visit(node.additionalProperties, path + ".*");
  };
  visit(schema, "");
  return [...groups]
    .map(([rule, paths]) => `${paths.join(", ")}: ${rule}`)
    .join("; ");
}

export function projectToolInterface({
  name,
  description,
  inputSchema,
}: ManifestTool): ModelTool {
  const bounds = schemaConstraints(inputSchema);
  return {
    type: "function",
    name,
    description:
      description +
      (bounds
        ? `\n\nParameter bounds (inclusive, when supplied): ${bounds}.`
        : ""),
    inputSchema,
  };
}

const mentions = (text: string, name: string) =>
  new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);

/**
 * A tool is model-visible only when it is direct and something executes it:
 * a host executor for host tools, a registered handler for the others.
 */
export class CircuitToolRegistry {
  records: Map<string, ManifestTool>;
  identity: Readonly<{
    id: string;
    version: string;
    schema: string;
    resultSchema: string;
  }>;
  workflow: string | null;
  tools: readonly ModelTool[];
  signature: string;
  constructor(
    manifest: Manifest,
    { hostTools, handlers }: { hostTools: string[]; handlers: string[] },
  ) {
    if (
      !object(manifest) ||
      Object.entries(CONTRACT).some(
        ([key, value]) => manifest[key] !== value,
      ) ||
      !/^1\.\d+\.\d+$/.test(manifest.version || "")
    )
      throw invalid("版本或结果 schema 不兼容");
    if (!Array.isArray(manifest.tools) || !manifest.tools.length)
      throw invalid("缺少工具定义");
    const records = new Map<string, ManifestTool>();
    for (const raw of manifest.tools) {
      if (
        !object(raw) ||
        raw.type !== "function" ||
        !/^[a-z][a-z0-9_]*$/.test(raw.name || "") ||
        typeof raw.description !== "string" ||
        !raw.description.trim() ||
        !object(raw.inputSchema) ||
        raw.inputSchema.type !== "object" ||
        !object(raw.inputSchema.properties) ||
        !["studio", "host"].includes(raw.owner) ||
        !["direct", "hidden"].includes(raw.exposure)
      )
        throw invalid("工具定义格式错误");
      if (records.has(raw.name)) throw invalid("重复工具：" + raw.name);
      records.set(raw.name, freeze(structuredClone(raw)));
    }
    const owned = (owner: string) =>
      [...records.values()]
        .filter((tool) => tool.owner === owner)
        .map((tool) => tool.name);
    const manifestHostTools = owned("host");
    if (
      manifestHostTools.length !== hostTools.length ||
      manifestHostTools.some((name) => !hostTools.includes(name))
    )
      throw invalid("工具 owner 与宿主执行器清单不一致");
    const studioTools = owned("studio");
    const stray = handlers.filter((name) => !studioTools.includes(name));
    if (stray.length)
      throw invalid("工具处理器不在目录中：" + stray.join("、"));
    const visible = [...records.values()].filter(
      (tool) =>
        tool.exposure === "direct" &&
        (tool.owner === "host" || handlers.includes(tool.name)),
    );
    const visibleNames = new Set(visible.map((tool) => tool.name));
    const unavailable = [...records.keys()].filter(
      (name) => !visibleNames.has(name),
    );
    for (const tool of visible) {
      const text = tool.description + JSON.stringify(tool.inputSchema);
      const named = unavailable.filter((name) => mentions(text, name));
      if (named.length)
        throw invalid(
          "模型可见工具说明引用隐藏工具：" +
            tool.name +
            "（" +
            named.join("、") +
            "）",
        );
    }
    this.records = records;
    this.identity = freeze({
      id: manifest.id,
      version: manifest.version,
      schema: manifest.schema,
      resultSchema: manifest.resultSchema,
    });
    this.workflow =
      typeof manifest.workflow === "string" ? manifest.workflow : null;
    this.tools = freeze(visible.map(projectToolInterface));
    // A live Codex thread keeps the tools it was opened with, so the signature
    // covers the rendered descriptions as well as the catalog entries.
    this.signature = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            ...this.identity,
            tools: [...visible].sort(byName),
            modelTools: [...this.tools].sort(byName),
          }),
        ),
      )
      .digest("hex");
  }
  /** Model-visible tools only. */
  get(name: string) {
    const tool = this.records.get(name);
    return tool && this.tools.some((item) => item.name === name) ? tool : null;
  }
  /** Any catalog entry, for internal calls of hidden tools. */
  record(name: string) {
    return this.records.get(name) || null;
  }
  label(name: string) {
    return this.records.get(name)?.label || name;
  }
}
