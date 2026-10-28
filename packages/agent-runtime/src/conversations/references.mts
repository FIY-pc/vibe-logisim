import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ReferenceInput,
  ReferenceSummary,
  StoredReference,
} from "./reference-types.ts";

const directory = (state: string, workspaceKey: string) =>
  path.join(
    state,
    "references",
    createHash("sha256").update(workspaceKey).digest("hex"),
  );
export function referenceSummary({
  workspaceKey: _,
  text: __,
  image: ___,
  ...summary
}: StoredReference): ReferenceSummary {
  return summary;
}
function checkedImage(value: unknown): string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length > 12_000_000 ||
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("图片无法引用，请缩小图片后重试");
  return value;
}
export async function storeReference(
  state: string,
  workspaceKey: string,
  documentId: string,
  input: ReferenceInput,
  host: (request: unknown) => Promise<any>,
): Promise<ReferenceSummary> {
  let fields: Omit<StoredReference, "id" | "workspaceKey" | "hasImage">;
  if (input?.kind === "material") {
    if (
      typeof input.label !== "string" ||
      !input.label.trim() ||
      typeof input.path !== "string" ||
      typeof (input.text ?? "") !== "string" ||
      (input.page !== undefined &&
        (!Number.isSafeInteger(input.page) || input.page < 1)) ||
      (input.pathVersion !== undefined &&
        (!Number.isSafeInteger(input.pathVersion) || input.pathVersion < 0)) ||
      (input.folderId !== undefined && typeof input.folderId !== "string")
    )
      throw new Error("资料引用无效");
    const text = input.text || "";
    fields = {
      kind: "material",
      label: input.label.slice(0, 300),
      path: input.path.slice(0, 4096),
      revision: input.revision?.slice(0, 128),
      folderId: input.folderId?.slice(0, 128),
      pathVersion: input.pathVersion,
      page: input.page,
      text: text.slice(0, 24_000),
      truncated: text.length > 24_000,
      image: checkedImage(input.image),
    };
  } else if (input?.kind === "observation") {
    if (input.documentId !== documentId)
      throw new Error("观察属于另一电路文档，请切换后引用");
    const render = await host({
      op: "observationImage",
      record: input.recordId,
    }).catch(() => undefined);
    const record = await host({
      op: "observationGet",
      id: documentId,
      record: input.recordId,
      limit: 0,
    }).catch(() => undefined);
    if (!record) throw new Error("这条观察已删除，请重新选择");
    const { frame, ...evidence } = record;
    fields = {
      kind: "observation",
      label: record.title,
      revision: record.revision,
      text: JSON.stringify({
        ...evidence,
        state: {
          circuit: frame.circuit,
          instancePath: frame.instancePath,
          clock: frame.clock,
        },
        historical: true,
      }),
      image: checkedImage(render),
    };
  } else throw new Error("不支持的引用");
  const record: StoredReference = {
    ...fields,
    id: randomUUID(),
    workspaceKey,
    hasImage: !!fields.image,
  };
  const target = directory(state, workspaceKey);
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, record.id + ".json"),
    JSON.stringify(record),
    { flag: "wx", mode: 0o600 },
  );
  return referenceSummary(record);
}
export async function readReferences(
  state: string,
  workspaceKey: string,
  ids: unknown,
): Promise<StoredReference[]> {
  if (
    !Array.isArray(ids) ||
    ids.length > 8 ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
  )
    throw new Error("每条问题最多引用 8 处资料或观察");
  const records = await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const record: StoredReference = JSON.parse(
        await readFile(
          path.join(directory(state, workspaceKey), id + ".json"),
          "utf8",
        ),
      );
      if (record.workspaceKey !== workspaceKey || record.id !== id)
        throw new Error("引用属于另一个工程文件夹");
      return record;
    }),
  );
  if (records.reduce((sum, r) => sum + (r.image?.length || 0), 0) > 24_000_000)
    throw new Error("引用图片合计过大，请减少引用后重试");
  return records;
}
