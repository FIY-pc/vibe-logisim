/**
 * Read-only tools: inspect_circuit (one bounded view per call), render_circuit
 * (PNG of a definition) and describe_component (a native component before it
 * is placed). All answers are identified by document, revision and circuit so
 * the model can tell stale pages from current ones.
 */
import { organizationContext } from "@vibe-logisim/arranger";
import { CircuitToolError } from "./errors.mts";
import { inspectView } from "./observe.mts";
import { layoutReview, reviewOptions } from "./layout-review.mts";
import type { ToolContext } from "./context.mts";

const DETAIL_KEYS = [
  "componentIds",
  "componentDirectory",
  "portConnections",
  "includeWires",
  "wireOffset",
  "wireLimit",
  "includeNets",
  "netFormat",
  "layoutReview",
];

export async function inspectCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const identity = context.identity(document, circuit);
  if (args.layoutContext !== undefined) {
    if (DETAIL_KEYS.some((k) => args[k] !== undefined))
      throw new CircuitToolError(
        "INVALID_ARGUMENT",
        "layoutContext 与其他明细筛选冲突。",
        {
          hint: "查看布局时只保留 circuit 和 layoutContext；不要同时请求 componentIds、portConnections、includeWires 等。",
        },
      );
    const source = await context.host.call<{ xml: string }>({
      op: "source",
      id: document.id,
      revision: document.revision,
    });
    const { raw } = await context.observe(document, circuit);
    return {
      ...identity,
      authority: "exact-runtime",
      layoutContext: organizationContext(
        source.xml,
        circuit,
        raw.focus,
        args.layoutContext || {},
      ),
    };
  }
  const review = reviewOptions({ ...args, circuit });
  if (review) {
    const { raw } = await context.observe(document, circuit);
    const digest = raw.artifactSha256 ?? raw.revision?.artifactSha256 ?? null;
    if (review.artifactSha256 && digest && review.artifactSha256 !== digest)
      throw new CircuitToolError(
        "STALE_ARTIFACT",
        "图面已改变，不能续接旧版布局问题；重新从 layoutReview:{} 开始。",
        { retryable: true },
      );
    const children = new Set<string>(
      (raw.focus.components || [])
        .map((c: any) => c.subcircuit)
        .filter((name: unknown) => typeof name === "string"),
    );
    return {
      ...identity,
      authority: "exact-runtime",
      artifactSha256: digest,
      childDefinitions: [...children].sort(),
      layoutReview: layoutReview(raw.focus, review.issueOffset),
    };
  }
  const { view } = await context.observe(document, circuit);
  return inspectView(view, identity, args);
}

export async function renderCircuit(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  let result: { image: string; viewport: Record<string, number> };
  try {
    result = await context.host.call({
      op: "render",
      id: document.id,
      revision: document.revision,
      circuit,
      ...(args.viewport ?? {}),
    });
  } catch (error: any) {
    throw new CircuitToolError(
      "RENDER_FAILED",
      "电路无法生成图像：" + circuit,
      {
        retryable: true,
        hint:
          "先确认定义名；电路为空时先放置元件。" +
          (error?.message ? ` (${error.message})` : ""),
      },
    );
  }
  return {
    ...context.identity(document, circuit),
    viewport: result.viewport,
    note: "图像按当前内容生成；改动后需要重新查看。",
    modelContentItems: [
      {
        type: "inputImage",
        mimeType: "image/png",
        imageData: result.image.split(",")[1],
      },
    ],
  };
}

/** `<attribute name label value editable><option value label/>…` rows of a template reply. */
export function templateAttributes(reply: any): Record<string, any> {
  const attributes: Record<string, any> = {};
  for (const node of reply?.children || []) {
    if (node.tag !== "attribute" || !node.attributes?.name) continue;
    const options = (node.children || [])
      .filter((o: any) => o.tag === "option")
      .map((o: any) => o.attributes?.value ?? o.text);
    attributes[node.attributes.name] = {
      label: node.attributes.label,
      value: node.attributes.value ?? "",
      ...(node.attributes.editable === "false" ? { editable: false } : {}),
      ...(options.length ? { options } : {}),
    };
  }
  return attributes;
}

/** `<bounds>` and `<port>` rows of a template reply, relative to the anchor. */
export function templateGeometry(reply: any) {
  const numbers = (a: Record<string, string>, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, Number(a[k])]));
  const bounds = (reply?.children || []).find((n: any) => n.tag === "bounds");
  const ports = (reply?.children || [])
    .filter((n: any) => n.tag === "port")
    .map((n: any) => ({
      ...numbers(n.attributes, ["index", "x", "y", "width"]),
      exclusive: n.attributes.exclusive === "true",
      ...(n.attributes.direction ? { direction: n.attributes.direction } : {}),
      ...(n.attributes.semanticRole
        ? { semanticRole: n.attributes.semanticRole }
        : {}),
      ...(n.attributes.runtimeTooltip
        ? { tooltip: n.attributes.runtimeTooltip }
        : {}),
    }));
  return {
    factory: reply?.attributes?.factory,
    facingAttribute: reply?.attributes?.facingAttribute ?? null,
    snap: reply?.attributes?.snap !== "false",
    bounds: bounds
      ? numbers(bounds.attributes, ["x", "y", "width", "height"])
      : null,
    ports,
  };
}

/**
 * Finds which library offers a tool name when the model omitted it: the
 * one group of the catalog that lists it. The group with the empty id is
 * this file's own subcircuits.
 */
export async function resolveLibrary(
  context: ToolContext,
  document: { id: string; revision: string },
  circuit: string,
  tool: string,
  library: string | null | undefined,
): Promise<string> {
  if (library !== undefined && library !== null) return library;
  const catalog = await context.host.call<any>({
    op: "catalog",
    id: document.id,
    revision: document.revision,
    circuit,
  });
  const hits: { id: string; name: string }[] = [];
  for (const group of catalog?.children || [])
    if (group.tag === "group")
      for (const entry of group.children || [])
        if (
          entry.tag === "tool" &&
          (entry.attributes?.name === tool ||
            entry.attributes?.factory === tool)
        )
          hits.push({
            id: group.attributes.id ?? "",
            name: group.attributes.name,
          });
  if (hits.length === 1) return hits[0].id;
  if (!hits.length)
    throw new CircuitToolError(
      "COMPONENT_NOT_FOUND",
      "当前文件的组件库里没有这个元件：" + tool,
      {
        hint: "元件名是 Logisim 的原生名称（如 AND Gate、Register、Pin）；子电路用定义名并把 library 设为空字符串。",
      },
    );
  throw new CircuitToolError(
    "INVALID_ARGUMENT",
    `多个组件库都有 ${tool}，请指定 library。`,
    {
      hint:
        "可选：" +
        hits.map((h) => `${h.name} (${JSON.stringify(h.id)})`).join("、"),
      context: { libraries: hits },
    },
  );
}

export async function describeComponent(
  context: ToolContext,
  args: Record<string, any>,
) {
  const { document, circuit } = await context.target(args);
  const library = await resolveLibrary(
    context,
    document,
    circuit,
    args.tool,
    args.library,
  );
  const reply = await context.host.call<any>({
    op: "template",
    id: document.id,
    revision: document.revision,
    circuit,
    library,
    name: args.tool,
    attributes: args.attributes ?? {},
  });
  return {
    ...context.identity(document, circuit),
    tool: args.tool,
    library,
    ...templateGeometry(reply),
    attributes: templateAttributes(reply),
    note: "这些是原生运行时给出的默认值和可选值；放入电路时只需要写出要改的属性，其余按默认值补全。bounds 和 ports 相对于锚点。",
  };
}
