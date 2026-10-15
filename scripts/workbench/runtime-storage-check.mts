/** Current-format persistence and provider parsing; no accounts or model requests. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../packages/agent-runtime/core/agent-runtime.mts";
import { ConversationStore } from "../../packages/agent-runtime/core/conversation-store.mts";
import { BuiltinProvider } from "../../packages/agent-runtime/core/builtin-provider.mts";
import { readProvider } from "../../packages/agent-runtime/core/provider-config.mts";

const directory = await mkdtemp(path.join(tmpdir(), "vibe-runtime-storage-"));
const options = {
  profileDir: path.join(directory, "profile"),
  workDir: path.join(directory, "work"),
  sessionStorePath: path.join(directory, "conversations.json"),
  startOnResume: false,
};
const runtimes: AgentRuntime[] = [];
try {
  await mkdir(options.workDir);
  const runtime = new AgentRuntime(options);
  runtimes.push(runtime);
  const existing = runtime.store.ensure("existing-document");
  assert.equal(existing.runtime, "builtin");
  runtime.setDefaultRuntime("codex");
  assert.equal(
    runtime.store.ensure("new-document").runtime,
    "codex",
    "A new workspace uses the selected default runtime",
  );
  assert.equal(
    runtime.store.ensure("existing-document").runtime,
    "builtin",
    "Changing the default does not rebind existing conversations",
  );
  const fresh = runtime.store.change("existing-document", "new");
  assert.equal(
    fresh.conversation.runtime,
    "codex",
    "New conversations use the updated default",
  );
  assert.equal(
    runtime.store.get("existing-document", existing.id).runtime,
    "builtin",
  );
  const restarted = new AgentRuntime(options);
  runtimes.push(restarted);
  assert.equal(restarted.defaultRuntime, "codex");
  assert.equal(
    restarted.store.ensure("after-restart").runtime,
    "codex",
    "Restart restores the default before creating a record",
  );
  restarted.setDefaultRuntime("builtin");
  assert.equal(restarted.store.ensure("after-restart").runtime, "codex");
  assert.equal(restarted.store.ensure("another-document").runtime, "builtin");

  const unsupported = path.join(directory, "unsupported-conversations.json");
  const original = JSON.stringify({
    schema: "vibe-logisim.codex-sessions/v1",
    workspaces: {},
  });
  await writeFile(unsupported, original);
  const store = new ConversationStore(unsupported);
  assert.throws(() => store.ensure("document"), /无法读取/);
  assert.throws(() => store.change("document", "new"), /无法读取/);
  assert.equal(
    await readFile(unsupported, "utf8"),
    original,
    "Unsupported history must never be replaced with a blank index",
  );

  const invalidProfile = path.join(directory, "unsupported-profile");
  await mkdir(invalidProfile);
  const servicePath = path.join(invalidProfile, "builtin-provider.json");
  const previousService = JSON.stringify({
    baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions",
  });
  await writeFile(servicePath, previousService);
  const provider = new BuiltinProvider(invalidProfile);
  assert.throws(() => provider.registry(), /配置无效/);
  assert.throws(
    () =>
      provider.save({
        name: "Fixture",
        baseUrl: "https://fixture.invalid/v1",
        apiKey: "fixture",
        model: "local-model",
        api: "openai-completions",
      }),
    /配置无效/,
  );
  assert.equal(await readFile(servicePath, "utf8"), previousService);
  const invalidSettings = path.join(invalidProfile, "runtime-selection.json");
  const invalidRuntime = JSON.stringify({ runtime: "unsupported" });
  await writeFile(invalidSettings, invalidRuntime);
  assert.throws(
    () => new AgentRuntime({ ...options, profileDir: invalidProfile }),
    /运行时设置无法读取/,
  );
  assert.equal(await readFile(invalidSettings, "utf8"), invalidRuntime);

  const config = path.join(directory, "provider.toml");
  await writeFile(
    config,
    [
      'model_provider = "fixture"',
      'model = "local-model"',
      'model_reasoning_effort = "max"',
      "[model_providers.fixture]",
      'name = "Local fixture"',
      'base_url = "http://127.0.0.1:1/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "fixture-only"',
    ].join("\n"),
  );
  const previousPath = process.env.PATH;
  let parsed: ReturnType<typeof readProvider>;
  try {
    process.env.PATH = path.join(directory, "no-system-programs");
    parsed = readProvider(config, { PATH: process.env.PATH });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(parsed.model, "local-model");
  assert.equal(parsed.effort, "max");
  assert.equal(parsed.environment.VIBE_LOGISIM_PROVIDER_TOKEN, "fixture-only");
  assert.ok(
    !parsed.toml.includes("fixture-only"),
    "Credential values must stay out of the generated child config",
  );
  assert.match(parsed.toml, /VIBE_LOGISIM_PROVIDER_TOKEN/);
  const malformed = 'model_provider = "unterminated';
  await writeFile(config, malformed);
  assert.throws(() => readProvider(config), /无法解析/);
  assert.equal(await readFile(config, "utf8"), malformed);
  console.log(
    "Verified default-runtime ownership across new workspaces and restart; unsupported stores remain unchanged; TOML parsing needs no Python and keeps credentials out of generated config.",
  );
} finally {
  await Promise.all(runtimes.map((runtime) => runtime.stop()));
  await rm(directory, { recursive: true, force: true });
}
