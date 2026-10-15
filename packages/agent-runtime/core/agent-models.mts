import type {
  NativeRequest,
  ModelRow,
  ModelSelection,
  ProtocolObject,
} from "./types.mts";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentModelError, classifyModelError } from "./model-errors.mts";

// Model discovery and local preferences are separate from conversation transport.
// The catalog comes from the same app-server that will execute the next turn.
class AgentModels {
  declare request: NativeRequest;
  declare preferencesPath: string | null;
  declare catalog: ModelRow[] | null;
  declare loading: Promise<ModelRow[]> | null;
  declare selection: ModelSelection | null;
  declare savedSelection: ModelSelection | null;
  declare catalogError: ProtocolObject | null;

  constructor({
    request,
    preferencesPath,
  }: {
    request: NativeRequest;
    preferencesPath: string | null;
  }) {
    this.request = request;
    this.preferencesPath = preferencesPath;
    this.catalog = null;
    this.loading = null;
    this.selection = null;
    this.savedSelection = null;
    this.catalogError = null;
    try {
      if (!preferencesPath) return;
      const saved = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
      if (
        typeof saved.model === "string" &&
        saved.model.length <= 160 &&
        (saved.effort === null || typeof saved.effort === "string") &&
        (saved.effort === null || saved.effort.length <= 30)
      )
        this.savedSelection = {
          model: saved.model,
          effort: saved.effort ?? null,
        };
    } catch (_: any) {
      /* No preference means inherit the configured connection. */
    }
  }

  invalidate() {
    this.catalog = null;
    this.loading = null;
    this.selection = null;
    this.catalogError = null;
  }

  state() {
    return {
      status: this.catalog
        ? "ready"
        : this.catalogError
          ? "unavailable"
          : "unknown",
      error: this.catalogError,
    };
  }

  #write(selection: any) {
    if (!this.preferencesPath) return;
    fs.mkdirSync(path.dirname(this.preferencesPath), { recursive: true });
    const temporary = `${this.preferencesPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(selection), { mode: 0o600 });
    fs.renameSync(temporary, this.preferencesPath);
  }

  #synchronizeSelection(catalog: any) {
    const candidate = this.savedSelection;
    if (!candidate) {
      this.selection = null;
      return;
    }
    const model = catalog.find((item: any) => item.model === candidate.model);
    const valid =
      model &&
      (candidate.effort === null ||
        model.efforts.some((item: any) => item.value === candidate.effort));
    if (valid) {
      this.selection = { model: model.model, effort: candidate.effort };
      return;
    }
    // A model catalog is connection-scoped. An old app preference must never
    // become an unverified turn/start override after reconnecting to another
    // provider or after Codex changes its model identifiers.
    this.#write(null);
    this.savedSelection = null;
    this.selection = null;
  }

  async list({ refresh = false }: any = {}) {
    if (!refresh && this.catalog) return this.catalog;
    if (this.loading) return this.loading;
    let loading!: Promise<ModelRow[]>;
    loading = (async () => {
      try {
        const models = new Map<string, ModelRow>(),
          seen = new Set<string | null>();
        let cursor = null;
        do {
          const result: ProtocolObject = await this.request("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          });
          if (!Array.isArray(result?.data))
            throw new Error("模型目录返回格式不正确");
          for (const model of result.data) {
            if (model.hidden || typeof model.model !== "string") continue;
            models.set(model.model, {
              model: model.model,
              name: model.displayName || model.model,
              description: model.description || "",
              isDefault: Boolean(model.isDefault),
              defaultEffort: model.defaultReasoningEffort,
              efforts: (model.supportedReasoningEfforts || []).map(
                (e: any) => ({
                  value: e.reasoningEffort,
                  description: e.description || "",
                }),
              ),
            });
          }
          cursor = result.nextCursor;
          if (cursor && seen.has(cursor))
            throw new Error("模型目录分页重复，请重新连接后刷新");
          seen.add(cursor);
        } while (cursor);
        const catalog = [...models.values()];
        if (!catalog.length) throw new Error("当前连接没有返回模型");
        if (this.loading === loading) {
          this.catalog = catalog;
          this.catalogError = null;
          this.#synchronizeSelection(catalog);
        }
        return catalog;
      } catch (error: any) {
        const wrapped = classifyModelError(error, { phase: "catalog" })!;
        if (this.loading === loading) this.catalogError = wrapped.asJSON();
        throw wrapped;
      }
    })();
    this.loading = loading;
    try {
      return await loading;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }

  validateConfigured(model: any, effort: any) {
    if (!model) return null;
    const entry = this.catalog?.find((item: any) => item.model === model);
    if (!entry) {
      throw new AgentModelError(
        "MODEL_UNAVAILABLE",
        `本机配置的模型「${model}」不在当前连接的模型目录中，请打开模型列表并选择可用模型。`,
        { retryable: false, phase: "config", model },
      );
    }
    if (effort && !entry.efforts.some((item: any) => item.value === effort)) {
      throw new AgentModelError(
        "MODEL_UNAVAILABLE",
        `本机配置的思考深度「${effort}」不适用于模型「${model}」，请打开模型列表重新选择。`,
        { retryable: false, phase: "config", model },
      );
    }
    return { model: entry.model, effort: effort ?? null };
  }

  async validate(selection: any) {
    if (selection === null) return null;
    if (
      !selection ||
      typeof selection.model !== "string" ||
      !(selection.effort === null || typeof selection.effort === "string")
    )
      throw new Error("请选择模型和思考深度");
    const model = (await this.list()).find(
      (m: any) => m.model === selection.model,
    );
    if (!model)
      throw new Error("这个模型不在当前连接的目录中，请刷新后重新选择");
    if (
      selection.effort !== null &&
      !model.efforts.some((e: any) => e.value === selection.effort)
    )
      throw new Error("这个模型不支持所选思考深度");
    return { model: model.model, effort: selection.effort ?? null };
  }

  save(selection: any) {
    this.#write(selection);
    this.savedSelection = selection;
    this.selection = selection;
  }
}
export { AgentModels };
