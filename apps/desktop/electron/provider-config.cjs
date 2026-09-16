"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");

// Python is already required by the circuit authority; use its TOML parser.
function readProvider(configPath, environment = process.env) {
  if (!fs.existsSync(configPath)) return {environment: {}, toml: ""};
  const program = [
    "import json,sys,tomllib",
    "with open(sys.argv[1], 'rb') as f: c=tomllib.load(f)",
    "name=c.get('model_provider', 'openai')",
    "print(json.dumps({'model':c.get('model'), 'effort':c.get('model_reasoning_effort'), 'name':name, 'provider':c.get('model_providers', {}).get(name)}))",
  ].join("\n");
  let config;
  try {
    config = JSON.parse(execFileSync(environment.VIBE_LOGISIM_PYTHON || "python3", ["-c", program, configPath],
      {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000}));
  } catch (_) {
    throw new Error("无法解析本机 Codex 的 TOML 配置。");
  }
  const provider = config.provider;
  const forwarded = {};
  function inherit(key) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !environment[key]) {
      throw new Error("Codex provider 所需的环境变量未设置：" + key);
    }
    forwarded[key] = environment[key];
  }
  if (provider) {
    if (provider.env_key) inherit(provider.env_key);
    if (provider.experimental_bearer_token) {
      forwarded.VIBE_LOGISIM_PROVIDER_TOKEN = provider.experimental_bearer_token;
      delete provider.experimental_bearer_token;
      provider.env_key = "VIBE_LOGISIM_PROVIDER_TOKEN";
    }
    for (const key of Object.values(provider.env_http_headers || {})) inherit(key);
    let headerIndex = 0;
    for (const [header, value] of Object.entries(provider.http_headers || {})) {
      const key = "VIBE_LOGISIM_PROVIDER_HEADER_" + headerIndex++;
      forwarded[key] = value;
      (provider.env_http_headers ||= {})[header] = key;
    }
    delete provider.http_headers;
  }
  const fields = [];
  if (config.model) fields.push("model = " + JSON.stringify(config.model));
  if (config.effort) fields.push("model_reasoning_effort = " + JSON.stringify(config.effort));
  if (provider) {
    fields.push("model_provider = " + JSON.stringify(config.name));
    fields.push("", "[model_providers." + JSON.stringify(config.name) + "]");
    const allowed = ["name", "base_url", "wire_api", "env_key", "env_key_instructions", "requires_openai_auth",
      "query_params", "env_http_headers", "request_max_retries", "stream_max_retries", "stream_idle_timeout_ms", "supports_websockets"];
    for (const key of allowed) if (provider[key] !== undefined) fields.push(key + " = " + tomlValue(provider[key]));
  }
  return {name: config.name, model: config.model, effort: config.effort, environment: forwarded, toml: fields.join("\n") + "\n"};
}

function tomlValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return "{ " + Object.entries(value).map(([k, v]) => JSON.stringify(k) + " = " + tomlValue(v)).join(", ") + " }";
  }
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(", ") + "]";
  return JSON.stringify(value);
}

function writeProvider(configPath, profileDir) {
  const settings = readProvider(configPath);
  fs.writeFileSync(path.join(profileDir, "config.toml"), settings.toml, {mode: 0o600});
  return settings;
}

module.exports = {readProvider, writeProvider};
