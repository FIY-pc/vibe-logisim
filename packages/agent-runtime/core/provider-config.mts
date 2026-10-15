import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import type { ProtocolObject } from "./types.mts";

// These fields affect model requests but do not grant the embedded process a
// new host surface. Approval, sandbox, feature, plugin and credential fields
// stay owned by the desktop harness. The embedded app-server runs with
// --strict-config, so only keys that Codex 0.153.x accepts at the top level
// may be mirrored; `disable_response_storage` is no longer such a key.
const PRESERVED_NATIVE_FIELDS = Object.freeze([
  "model_context_window",
  "service_tier",
  "personality",
  "model_reasoning_summary",
  "model_verbosity",
]);

function readProvider(
  configPath: string,
  environment = process.env,
  options: any = {},
) {
  if (!fs.existsSync(configPath)) return { environment: {}, toml: "" };
  let config: ProtocolObject;
  try {
    const source = parse(fs.readFileSync(configPath, "utf8")) as ProtocolObject;
    const name = source.model_provider || "openai";
    config = {
      model: source.model,
      effort: source.model_reasoning_effort,
      modelCatalogJson: source.model_catalog_json,
      name,
      provider: source.model_providers?.[name],
      preserved: Object.fromEntries(
        PRESERVED_NATIVE_FIELDS.filter((key) => Object.hasOwn(source, key)).map(
          (key) => [key, source[key]],
        ),
      ),
    };
  } catch {
    throw new Error("无法解析 Codex 的 TOML 配置，原文件已保留。");
  }
  const provider = config.provider;
  const forwarded: Record<string, string> = {};
  function inherit(key: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !environment[key]) {
      throw new Error("Codex provider 所需的环境变量未设置：" + key);
    }
    forwarded[key] = environment[key]!;
  }
  if (provider) {
    if (provider.env_key) inherit(provider.env_key);
    if (provider.experimental_bearer_token) {
      forwarded.VIBE_LOGISIM_PROVIDER_TOKEN =
        provider.experimental_bearer_token;
      delete provider.experimental_bearer_token;
      provider.env_key = "VIBE_LOGISIM_PROVIDER_TOKEN";
    }
    for (const key of Object.values(provider.env_http_headers || {}))
      inherit(String(key));
    let headerIndex = 0;
    for (const [header, value] of Object.entries(provider.http_headers || {})) {
      const key = "VIBE_LOGISIM_PROVIDER_HEADER_" + headerIndex++;
      forwarded[key] = String(value);
      (provider.env_http_headers ||= {})[header] = key;
    }
    delete provider.http_headers;
  }
  const fields = [];
  if (config.model) fields.push("model = " + JSON.stringify(config.model));
  let modelCatalogJson =
    typeof config.modelCatalogJson === "string" && config.modelCatalogJson
      ? config.modelCatalogJson
      : null;
  if (modelCatalogJson && options.profileDir) {
    const catalogSource = path.resolve(
      path.dirname(configPath),
      config.modelCatalogJson,
    );
    const catalogName = path.basename(config.modelCatalogJson);
    const catalogTarget = path.join(options.profileDir, catalogName);
    try {
      if (fs.statSync(catalogSource).isFile()) {
        fs.copyFileSync(catalogSource, catalogTarget);
        modelCatalogJson = catalogName;
      }
    } catch (_: any) {
      // Codex can refresh the catalog from the configured provider when the
      // local cache is absent. Do not make connection startup depend on it.
      modelCatalogJson = null;
    }
  }
  if (modelCatalogJson)
    fields.push("model_catalog_json = " + JSON.stringify(modelCatalogJson));
  if (config.effort)
    fields.push("model_reasoning_effort = " + JSON.stringify(config.effort));
  for (const key of PRESERVED_NATIVE_FIELDS) {
    if (Object.hasOwn(config.preserved || {}, key))
      fields.push(key + " = " + tomlValue(config.preserved[key]));
  }
  if (provider) {
    fields.push("model_provider = " + JSON.stringify(config.name));
    fields.push("", "[model_providers." + JSON.stringify(config.name) + "]");
    const allowed = [
      "name",
      "base_url",
      "wire_api",
      "env_key",
      "env_key_instructions",
      "requires_openai_auth",
      "query_params",
      "env_http_headers",
      "request_max_retries",
      "stream_max_retries",
      "stream_idle_timeout_ms",
      "supports_websockets",
    ];
    for (const key of allowed)
      if (provider[key] !== undefined)
        fields.push(key + " = " + tomlValue(provider[key]));
  }
  return {
    name: config.name,
    model: config.model,
    effort: config.effort,
    modelCatalogJson,
    preserved: config.preserved || {},
    environment: forwarded,
    toml: fields.join("\n") + "\n",
  };
}

function tomlValue(value: any): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      "{ " +
      Object.entries(value)
        .map(([k, v]: any) => JSON.stringify(k) + " = " + tomlValue(v))
        .join(", ") +
      " }"
    );
  }
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(", ") + "]";
  return JSON.stringify(value);
}

function writeProvider(configPath: string, profileDir: any) {
  const settings = readProvider(configPath, process.env, { profileDir });
  fs.writeFileSync(path.join(profileDir, "config.toml"), settings.toml, {
    mode: 0o600,
  });
  return settings;
}

export { readProvider, writeProvider };
