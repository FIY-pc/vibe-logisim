"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {classifyModelError} = require("./model-errors.cjs");

// Model discovery and local preferences are separate from conversation transport.
// The catalog comes from the same app-server that will execute the next turn.
class AgentModels {
  constructor({request, preferencesPath}) {
    this.request = request;
    this.preferencesPath = preferencesPath;
    this.catalog = null;
    this.loading = null;
    this.selection = null;
    this.savedSelection = null;
    this.catalogError = null;
    try {
      const saved = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
      if (typeof saved.model === "string" && saved.model.length <= 160 &&
          (saved.effort === null || typeof saved.effort === "string") &&
          (saved.effort === null || saved.effort.length <= 30)) this.savedSelection = {model:saved.model, effort:saved.effort ?? null};
    } catch (_) { /* No preference means inherit the configured connection. */ }
  }

  invalidate() {
    this.catalog = null;
    this.loading = null;
    this.selection = null;
    this.catalogError = null;
  }

  state() {
    return {
      status: this.catalog ? "ready" : this.catalogError ? "unavailable" : "unknown",
      error: this.catalogError,
    };
  }

  #write(selection) {
    if (!this.preferencesPath) return;
    fs.mkdirSync(path.dirname(this.preferencesPath), {recursive:true});
    const temporary = `${this.preferencesPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(selection), {mode:0o600});
    fs.renameSync(temporary, this.preferencesPath);
  }

  #synchronizeSelection(catalog) {
    const candidate = this.savedSelection;
    if (!candidate) {
      this.selection = null;
      return;
    }
    const model = catalog.find(item => item.model === candidate.model);
    const valid = model && (candidate.effort === null || model.efforts.some(item => item.value === candidate.effort));
    if (valid) {
      this.selection = {model:model.model, effort:candidate.effort};
      return;
    }
    // A model catalog is connection-scoped. An old app preference must never
    // become an unverified turn/start override after reconnecting to another
    // provider or after Codex changes its model identifiers.
    this.#write(null);
    this.savedSelection = null;
    this.selection = null;
  }

  async list({refresh = false} = {}) {
    if (!refresh && this.catalog) return this.catalog;
    if (this.loading) return this.loading;
    const loading = (async () => {
      try {
        const models = new Map(), seen = new Set();
        let cursor = null;
        do {
          const result = await this.request("model/list", {limit:100, includeHidden:false, ...(cursor ? {cursor} : {})});
          if (!Array.isArray(result?.data)) throw new Error("模型目录返回格式不正确");
          for (const model of result.data) {
            if (model.hidden || typeof model.model !== "string") continue;
            models.set(model.model, {
              model:model.model, name:model.displayName || model.model, description:model.description || "",
              isDefault:Boolean(model.isDefault),
              defaultEffort:model.defaultReasoningEffort,
              efforts:(model.supportedReasoningEfforts || []).map(e=>({value:e.reasoningEffort,description:e.description || ""})),
            });
          }
          cursor = result.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("模型目录分页重复，请重新连接后刷新");
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
      } catch (error) {
        const wrapped = classifyModelError(error, {phase:"catalog"});
        if (this.loading === loading) this.catalogError = wrapped.asJSON();
        throw wrapped;
      }
    })();
    this.loading = loading;
    try { return await loading; }
    finally { if (this.loading === loading) this.loading = null; }
  }

  async validate(selection) {
    if (selection === null) return null;
    if (!selection || typeof selection.model !== "string" ||
        !(selection.effort === null || typeof selection.effort === "string")) throw new Error("请选择模型和思考深度");
    const model = (await this.list()).find(m=>m.model===selection.model);
    if (!model) throw new Error("这个模型不在当前连接的目录中，请刷新后重新选择");
    if (selection.effort !== null && !model.efforts.some(e=>e.value===selection.effort)) throw new Error("这个模型不支持所选思考深度");
    return {model:model.model,effort:selection.effort ?? null};
  }

  save(selection) {
    this.#write(selection);
    this.savedSelection = selection;
    this.selection = selection;
  }
}
module.exports = {AgentModels};
