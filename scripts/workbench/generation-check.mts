/** Inspect requests produced by the real SDK without contacting a model service. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  ServiceStore,
  modelFor,
  transport,
} from "../../packages/agent-runtime/src/models/services.mts";
import { generationPayload } from "../../packages/agent-runtime/src/models/generation.mts";
import { selectionFor } from "../../packages/agent-runtime/src/models/selection.mts";
import { validate } from "../../packages/agent-runtime/src/models/validate.mts";
import type { ServiceConfig } from "../../packages/agent-runtime/src/models/types.mts";

const base: ServiceConfig = {
  id: "local",
  name: "Local model",
  api: "openai-responses",
  baseUrl: "https://model.example/v1",
  apiKey: "local-test-key",
  model: "fixture-model",
  contextWindow: 1000000,
  effort: "none",
  vision: false,
};
const context = normalizeContext({
  messages: [
    { role: "user", content: "Continue working.", timestamp: Date.now() },
  ],
});
async function capture(config: ServiceConfig, metadata: any = null) {
  let body: any;
  const api = await transport(config.api);
  const stream = await api.streamSimple(modelFor(config, metadata), context, {
    apiKey: config.apiKey,
    onPayload: generationPayload(config, metadata),
    maxRetries: 0,
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      // Authentication and request construction have run; no network is used.
      return new Response(JSON.stringify({ error: { message: "captured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const response = await stream.result();
  assert.equal(response.stopReason, "error");
  assert.ok(body, "the SDK must reach the supplied transport");
  return body;
}
for (const api of [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
]) {
  const config = { ...base, api };
  for (const maxOutput of [32768, 131072]) {
    const body = await capture(config, { maxOutput });
    assert.equal(
      body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens,
      maxOutput,
    );
  }
  const custom = await capture(
    { ...config, maxOutput: 65536 },
    { maxOutput: 32768 },
  );
  assert.equal(
    custom.max_output_tokens ??
      custom.max_completion_tokens ??
      custom.max_tokens,
    65536,
  );
  if (api !== "anthropic-messages") {
    const unknown = await capture(config);
    for (const key of [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
    ])
      assert.equal(
        unknown[key],
        undefined,
        "unknown models use endpoint defaults, not a guessed cap",
      );
  } else {
    assert.throws(() => generationPayload(config), /高级设置/);
  }
}
assert.equal(validate({ ...base, contextWindow: 8000 }).contextWindow, 8000);
assert.equal(
  validate({ ...base, contextWindow: 5000000 }).contextWindow,
  5000000,
);
assert.throws(() => validate({ ...base, contextWindow: -1 }), /正整数/);
assert.throws(() => validate({ ...base, maxOutput: 0 }), /正整数/);
const directory = await mkdtemp(path.join(tmpdir(), "vibe-generation-"));
try {
  const store = new ServiceStore(directory);
  const saved = store.save({ ...base, maxOutput: 131072 });
  assert.equal(selectionFor(store.read(saved.id))?.maxOutput, 131072);
  store.save({ ...saved, maxOutput: undefined });
  assert.equal(store.read(saved.id)?.maxOutput, undefined);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Verified actual SDK request output caps, endpoint defaults, explicit overrides and uncapped context configuration; no model calls.",
);
