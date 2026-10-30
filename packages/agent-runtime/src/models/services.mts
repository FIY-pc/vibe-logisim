import type {
  ServiceConfig,
  PublicService,
  ServiceSelection,
} from "./types.mts";
interface ServiceRegistry {
  version: 2;
  defaultId: string | null;
  services: ServiceConfig[];
}
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loadSdk } from "./sdk-loader.mts";
import { validate, maskKey } from "./validate.mts";
import { publicText } from "./public-fields.mts";
const APIS = ["openai-completions", "openai-responses", "anthropic-messages"];
function atomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
// Stable service records own credentials; conversations hold only their IDs.
const serviceEndpoint = (c: Partial<ServiceConfig> | null | undefined) =>
  String(c?.baseUrl || "").replace(/\/+$/, "");
const matches = (
  a: Partial<ServiceConfig> | null | undefined,
  b: Partial<ServiceConfig> | null | undefined,
) =>
  Boolean(
    a && b && serviceEndpoint(a) === serviceEndpoint(b) && a.api === b.api,
  );
const publicService = (c: ServiceConfig | null): PublicService | null => {
  if (!c) return null;
  const { apiKey, ...rest } = c;
  return { ...rest, name: publicText(rest.name, apiKey), model: publicText(rest.model, apiKey), baseUrl: publicText(rest.baseUrl, apiKey), models: rest.models?.map((m) => publicText(m, apiKey)), apiKeyHint: maskKey(apiKey) };
};
class ServiceStore {
  declare profileDir: string;
  declare file: string;

  constructor(profileDir: string) {
    this.profileDir = profileDir;
    this.file = path.join(profileDir, "builtin-provider.json");
  }
  registry(): ServiceRegistry {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw new Error("模型服务配置无法读取，原文件已保留");
      return { version: 2, defaultId: null, services: [] };
    }
    if (
      saved?.version !== 2 ||
      !Array.isArray(saved.services) ||
      saved.services.some((c: any) => !c.id || !c.baseUrl || !c.api)
    )
      throw new Error("模型服务配置无效，原文件已保留");
    return saved;
  }
  read(id?: string | null) {
    const r = this.registry();
    return (
      r.services.find(
        (c: any) => c.id === (id === undefined ? r.defaultId : id),
      ) || null
    );
  }
  resolve(selection: ServiceSelection | null) {
    if (!selection) return this.read();
    const config = this.read(selection.serviceId);
    return matches(selection, config) ? config : null;
  }

  visible(id?: string | null) {
    return publicService(this.read(id));
  }
  visibleSelection(selection: ServiceSelection | null) {
    return publicService(this.resolve(selection));
  }
  list() {
    return this.registry().services.map((c) => publicService(c)!);
  }
  validate(input: Partial<ServiceConfig>): Omit<ServiceConfig, "id"> {
    const old = input.id ? this.read(input.id) : null;
    const same = old && serviceEndpoint(input) === serviceEndpoint(old);
    const value = validate(
      { ...input, effort: input.effort || "none" },
      { storedApiKey: same ? old.apiKey : null },
    );
    const api = input.api || "openai-completions";
    if (!APIS.includes(api)) throw new Error("不支持这个接口协议");
    return {
      ...value,
      effort: value.effort as ServiceConfig["effort"],
      api,
      vision: input.vision === true,
    };
  }
  save(input: Partial<ServiceConfig>) {
    const r = this.registry(),
      value = this.validate(input),
      old = r.services.find((c: any) => c.id === input.id);
    // An edited endpoint/protocol is a new destination, preserving old bindings.
    const id = matches(old, value) ? old!.id : randomUUID();
    const next = { ...value, id };
    const index = r.services.findIndex((c: any) => c.id === id);
    if (index < 0) r.services.push(next);
    else r.services[index] = next;
    r.defaultId ||= id;
    atomic(this.file, r);
    return publicService(next)!;
  }
  setDefault(id: string) {
    const r = this.registry();
    if (!r.services.some((c: any) => c.id === id))
      throw new Error("模型服务不存在");
    r.defaultId = id;
    atomic(this.file, r);
  }
  clear(id?: string) {
    const r = this.registry(),
      target = id === undefined ? r.defaultId : id;
    r.services = r.services.filter((c: any) => c.id !== target);
    if (r.defaultId === target) r.defaultId = r.services[0]?.id || null;
    atomic(this.file, r);
  }
}
function modelFor(
  config: Omit<ServiceConfig, "id"> & { id?: string },
  metadata: any = null,
): Model<any> {
  // Pi otherwise clamps xhigh/max to high. Manual choices must reach the
  // service unchanged; an unsupported value should fail visibly there.
  const extended = config.effort === "xhigh" || config.effort === "max";
  const adaptive =
    config.api === "anthropic-messages" &&
    (extended || (metadata?.efforts?.length && !metadata.budgetThinking));
  // Pi omits the strict flag for Responses unless this compatibility switch is
  // set. With it, ordinary tool declarations are sent as strict:false. Omitting
  // strict lets Responses normalize optional fields into required fields,
  // breaking omission-based views such as inspect_circuit. Keep the executable
  // schema intact; validation still belongs to the tool host and domain.
  const compat =
    config.api === "openai-responses"
      ? { supportsStrictMode: true }
      : adaptive
        ? { forceAdaptiveThinking: true }
        : null;
  return {
    id: config.model,
    name: config.model,
    api: config.api,
    provider:
      "vibe-" +
      createHash("sha256")
        .update(
          (config.id || "") +
            "\n" +
            config.baseUrl.replace(/\/+$/, "") +
            "\n" +
            config.api,
        )
        .digest("hex")
        .slice(0, 24),
    baseUrl: config.baseUrl,
    reasoning: config.effort !== "none",
    input: config.vision ? ["text", "image"] : ["text"],
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    ...(compat ? { compat } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: 8192,
  };
}
async function transport(api: string): Promise<{ streamSimple: StreamFn }> {
  const sdk = await loadSdk();
  if (api === "openai-responses")
    return { streamSimple: sdk.responses as StreamFn };
  if (api === "anthropic-messages")
    return { streamSimple: sdk.anthropic as StreamFn };
  if (api === "openai-completions")
    return { streamSimple: sdk.completions as StreamFn };
  throw new Error("不支持这个接口协议");
}
export { ServiceStore, modelFor, transport, atomic, APIS };
