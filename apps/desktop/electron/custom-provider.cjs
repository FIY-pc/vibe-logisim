"use strict";

// A student-supplied OpenAI-compatible endpoint (relay, DeepSeek, Qwen, ...)
// becomes a normal Codex model provider: we write provider.toml, which
// provider-config.cjs already mirrors into the isolated profile, plus a
// one-entry model catalog so the model passes Codex's catalog precheck. The
// API key is kept as experimental_bearer_token in provider.toml (0600) and is
// forwarded to the app-server only through an environment variable.

const fs = require("node:fs");
const path = require("node:path");

const PROVIDER_ID = "custom";
const CATALOG_FILE = "custom-catalog.json";
const PROVIDER_FILE = "provider.toml";

// Codex's own instructions template is GPT-specific and ~21 KB. A generic
// OpenAI-compatible model gets a short equivalent; the circuit domain context
// still arrives separately as developerInstructions from CodexBackend.
const GENERIC_INSTRUCTIONS = `You are an AI agent working with the user inside one shared workspace folder. Carry the user's request through to completion; bias toward action and do not stop at proposing a plan.

Communication: while working, send short progress notes on the commentary channel. End your turn with a self-contained final message that leads with the outcome. Answer in the user's language. Use GitHub-flavored Markdown; leave a blank line before lists. When referencing a local file, use a markdown link with the absolute path as the target.

Tools: functions.exec runs JavaScript that can call the tools listed in the tool namespace, including exec_command for shell commands. Batch independent reads in one exec call and keep dependent steps sequential. Treat command text as code and quote it properly. Do not ask for permission for reversible or read-only actions; explain briefly when you truly need the user to decide something.

Evidence: distinguish what you observed from what you infer. When a tool reports an error, read it and adjust instead of repeating the same call.`;

function normaliseBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) throw new Error("请填写接口地址，例如 https://api.deepseek.com/v1");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("接口地址格式不正确"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("接口地址不能包含账号、查询参数或锚点");
  // Codex appends /responses itself; accept both ".../v1" and ".../v1/".
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/(responses|chat\/completions)$/, "");
  return parsed.origin + parsed.pathname;
}

function validate(settings) {
  const baseUrl = normaliseBaseUrl(settings.baseUrl);
  const apiKey = String(settings.apiKey || "").trim();
  if (!apiKey) throw new Error("请填写 API 密钥");
  if (/[\r\n"\\]/.test(apiKey) || apiKey.length > 512) throw new Error("API 密钥格式不正确");
  const model = String(settings.model || "").trim();
  if (!model) throw new Error("请填写模型名称，例如 deepseek-chat");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/.test(model)) throw new Error("模型名称只能包含字母、数字和 . _ : / -");
  const efforts = ["low", "medium", "high"];
  const effort = efforts.includes(settings.effort) ? settings.effort : "medium";
  const name = String(settings.name || "").trim().slice(0, 40) || "自定义接口";
  // Context window drives Codex's auto-compaction. Too small and a long
  // construction turn compacts every few minutes and loses its working state
  // (observed on a course task: 2 compactions in 16 min at 128k). Frontier
  // models via relays accept 200k+; let the student say what their model has.
  let contextWindow = Number(settings.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) contextWindow = 256000;
  contextWindow = Math.max(32000, Math.min(2000000, Math.round(contextWindow)));
  return {baseUrl, apiKey, model, effort, name, contextWindow};
}

function catalogEntry(model, effort, contextWindow = 256000) {
  // Every field below is required by Codex 0.153/0.154's catalog parser
  // (verified with --strict-config); values are neutral for a generic model.
  return {
    slug: model,
    display_name: model,
    description: "自定义 OpenAI 兼容接口的模型",
    default_reasoning_level: effort,
    supported_reasoning_levels: [
      {effort: "low", description: "更快"},
      {effort: "medium", description: "均衡"},
      {effort: "high", description: "更深入的推理"},
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    model_messages: {instructions_template: GENERIC_INSTRUCTIONS},
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: {mode: "tokens", limit: 10000},
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    comp_hash: "0",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    tool_mode: "code_mode_only",
    multi_agent_version: "v1",
    multi_agent_reasoning_effort: effort,
  };
}

function providerToml(settings) {
  return [
    `model = ${JSON.stringify(settings.model)}`,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `model_catalog_json = ${JSON.stringify(CATALOG_FILE)}`,
    `model_reasoning_effort = ${JSON.stringify(settings.effort)}`,
    `model_context_window = ${settings.contextWindow}`,
    "",
    `[model_providers.${PROVIDER_ID}]`,
    `name = ${JSON.stringify(settings.name)}`,
    `base_url = ${JSON.stringify(settings.baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `experimental_bearer_token = ${JSON.stringify(settings.apiKey)}`,
    "",
  ].join("\n");
}

// Writes provider.toml + catalog into the profile directory. Returns the
// validated settings (without the key) for the caller to report.
function saveCustomProvider(profileDir, input) {
  const settings = validate(input || {});
  fs.mkdirSync(profileDir, {recursive: true, mode: 0o700});
  const catalogPath = path.join(profileDir, CATALOG_FILE);
  const providerPath = path.join(profileDir, PROVIDER_FILE);
  const writeAtomic = (target, contents) => {
    const temp = target + ".tmp";
    fs.writeFileSync(temp, contents, {mode: 0o600});
    fs.renameSync(temp, target);
  };
  writeAtomic(catalogPath, JSON.stringify({models: [catalogEntry(settings.model, settings.effort, settings.contextWindow)]}));
  writeAtomic(providerPath, providerToml(settings));
  const {apiKey, ...visible} = settings;
  return {...visible, apiKeyHint: maskKey(apiKey)};
}

function clearCustomProvider(profileDir) {
  for (const name of [PROVIDER_FILE, CATALOG_FILE]) fs.rmSync(path.join(profileDir, name), {force: true});
}

function readCustomProvider(profileDir) {
  const providerPath = path.join(profileDir, PROVIDER_FILE);
  if (!fs.existsSync(providerPath)) return null;
  const text = fs.readFileSync(providerPath, "utf8");
  const pick = key => { const match = text.match(new RegExp(`^${key} = "((?:[^"\\\\]|\\\\.)*)"`, "m")); return match ? JSON.parse(`"${match[1]}"`) : null; };
  if (pick("model_provider") !== PROVIDER_ID) return null;
  const window = text.match(/^model_context_window = (\d+)/m);
  return {name: pick("name"), baseUrl: pick("base_url"), model: pick("model"), effort: pick("model_reasoning_effort") || "medium",
    contextWindow: window ? Number(window[1]) : null, apiKeyHint: maskKey(pick("experimental_bearer_token") || "")};
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

module.exports = {saveCustomProvider, clearCustomProvider, readCustomProvider, validate, catalogEntry, PROVIDER_ID, CATALOG_FILE, PROVIDER_FILE};
