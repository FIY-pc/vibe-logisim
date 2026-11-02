/** Local OAuth + Responses round trip. Never contacts an account or spends credits. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { ChatGPTAccounts } from "../../packages/agent-runtime/src/models/chatgpt.mts";
import {
  chatgptFetch,
  chatgptPayload,
} from "../../packages/agent-runtime/src/models/chatgpt-responses.mts";
import {
  ServiceStore,
  modelFor,
  transport,
} from "../../packages/agent-runtime/src/models/services.mts";
import {
  configurationIssue,
  selectionFor,
} from "../../packages/agent-runtime/src/models/selection.mts";
import {
  TurnRunner,
  retryingStream,
} from "../../packages/agent-runtime/src/turn/runner.mts";
import { loadSdk } from "../../packages/agent-runtime/src/models/sdk-loader.mts";

const temp = await mkdtemp(path.join(tmpdir(), "vibe-chatgpt-check-"));
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "local-test",
  alg: "RS256",
  use: "sig",
};
let issuer = "",
  nonce = "",
  scope = "openid resource.invoke chatgpt.tokens.use.direct offline_access";
let subject = "local-subject",
  clientId = "oaiapp_local",
  badNonce = false;
let refreshError = "",
  revokeError = false,
  refreshCount = 0,
  responseMode = "tools";
const forms: URLSearchParams[] = [],
  payloads: any[] = [];
const serverErrors: unknown[] = [];
const server = createServer((req, res) => {
  void (async () => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString();
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/.well-known/openid-configuration")
      return json({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
      });
    if (req.url === "/jwks") return json({ keys: [jwk] });
    if (req.url === "/api/accounts/oauth/token") {
      const form = new URLSearchParams(body);
      forms.push(form);
      const refresh = form.get("grant_type") === "refresh_token";
      if (refresh) {
        refreshCount++;
        assert.equal(form.has("scope"), false);
        assert.equal(form.get("client_id"), "oaiapp_local");
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (refreshError)
          return json(
            { error: refreshError },
            refreshError === "temporary" ? 503 : 400,
          );
      }
      const idToken = await new SignJWT({
        nonce: badNonce ? "wrong" : nonce,
        email: "tester@example.com",
      })
        .setProtectedHeader({ alg: "RS256", kid: "local-test" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      return json({
        access_token: `local-access-${refreshCount}`,
        refresh_token: `local-refresh-${refreshCount}`,
        id_token: idToken,
        token_type: "Bearer",
        scope,
        expires_in: 3600,
      });
    }
    if (req.url === "/revoke") {
      forms.push(new URLSearchParams(body));
      if (revokeError) return json({}, 503);
      res.writeHead(200).end();
      return;
    }
    if (req.url === "/v1/models") {
      assert.match(req.headers.authorization || "", /^Bearer local-access-/);
      return json({
        models: [
          { slug: "fixture-hidden", visibility: "hidden" },
          {
            slug: "fixture-chatgpt",
            display_name: "Local ChatGPT model",
            visibility: "list",
            context_window: 160000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium" }],
          },
        ],
      });
    }
    if (req.url === "/v1/responses") {
      assert.match(req.headers.authorization || "", /^Bearer local-access-/);
      const p = JSON.parse(body);
      payloads.push(p);
      assert.equal(p.store, false);
      assert.equal(p.stream, true);
      assert.equal(p.max_output_tokens, undefined);
      assert.equal(p.temperature, undefined);
      assert.equal(p.previous_response_id, undefined);
      assert.ok(p.input.every((i: any) => i.role !== "system"));
      if (p.tools?.length) {
        assert.equal(p.tools[0].type, "namespace");
        assert.equal(p.tools[0].name, "vibe_logisim");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (type: string, value: object) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
        );
      event("response.created", {
        response: { id: "resp_local", status: "in_progress", output: [] },
      });
      if (responseMode === "cut") {
        res.end();
        return;
      }
      if (responseMode === "limit") {
        event("response.failed", {
          response: {
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Local usage limit",
            },
          },
        });
        res.end();
        return;
      }
      const toolResult = p.input.some(
        (i: any) => i.type === "function_call_output",
      );
      const item = toolResult
        ? {
            type: "message",
            id: "msg_local",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Circuit inspected.",
                annotations: [],
              },
            ],
          }
        : {
            type: "function_call",
            namespace: "vibe_logisim",
            id: "fc_local",
            call_id: "call_local",
            name: "inspect_circuit",
            arguments: '{"circuit":"main"}',
            status: "completed",
          };
      if (toolResult)
        assert.equal(
          p.input.find((i: any) => i.type === "function_call").namespace,
          "vibe_logisim",
        );
      event("response.output_item.added", { output_index: 0, item });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", {
        response: {
          id: "resp_local",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      res.end();
      return;
    }
    json({}, 404);
  })().catch((e) => {
    serverErrors.push(e);
    res.writeHead(500).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
issuer = `http://127.0.0.1:${address.port}`;
const options = {
  issuer,
  api: `${issuer}/v1`,
  changed: () => {},
  fetchFor: async () => fetch,
};
let auth = new ChatGPTAccounts(temp, options);
const accountsFile = path.join(temp, "chatgpt-accounts.json");
const finish = async (
  login: Awaited<ReturnType<typeof auth.begin>>,
  override: Record<string, string> = {},
) => {
  const url = new URL(login.url);
  nonce = url.searchParams.get("nonce")!;
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "local-code",
    client_id: clientId,
    ...override,
  }).toString();
  await fetch(callback);
  for (
    let i = 0;
    i < 100 && auth.status(login.attemptId).status === "pending";
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  return auth.status(login.attemptId);
};
const expire = async () => {
  const saved = JSON.parse(await readFile(accountsFile, "utf8"));
  saved.accounts[0].tokens.expiresAt = 0;
  await writeFile(accountsFile, JSON.stringify(saved));
};
try {
  const login = await auth.begin();
  const start = new URL(login.url);
  assert.equal(start.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(start.searchParams.get("agent_name_hint"), "Vibe Logisim");
  assert.match(
    start.searchParams.get("redirect_uri")!,
    /^http:\/\/127.0.0.1:\d+\/auth\/callback$/,
  );
  await finish(login, { state: "wrong" });
  assert.equal(forms.length, 0, "wrong state must not exchange credentials");
  const completed = await finish(login);
  assert.equal(completed.status, "complete");
  assert.equal(completed.welcome, true);
  const id = completed.serviceId!;
  assert.equal(forms[0].get("client_id"), clientId);
  assert.equal(
    forms[0].get("redirect_uri"),
    start.searchParams.get("redirect_uri"),
  );
  assert.equal(
    createHash("sha256")
      .update(forms[0].get("code_verifier")!)
      .digest("base64url"),
    start.searchParams.get("code_challenge"),
  );
  assert.equal((await stat(accountsFile)).mode & 0o777, 0o600);
  const store = new ServiceStore(temp, auth);
  const api = store.save({
    name: "API",
    baseUrl: "https://api.example.com/v1",
    apiKey: "local-api-key",
    model: "fixture-api",
    contextWindow: 128000,
    effort: "none",
  });
  store.setDefault(id);
  assert.equal(store.read()?.id, id);
  assert.doesNotMatch(
    JSON.stringify(store.list()),
    /local-access|local-refresh|eyJ/,
  );
  assert.equal(store.read(api.id)?.apiKey, "local-api-key");
  await assert.rejects(
    async () => store.save({ ...store.read(id)! }),
    /登录管理/,
  );
  auth.welcome(id);
  auth = new ChatGPTAccounts(temp, options);
  assert.equal(await auth.access(id), "local-access-0");
  const models = await auth.models(id, true);
  assert.deepEqual(
    models.map((m) => m.model),
    ["fixture-chatgpt"],
  );
  assert.equal(models[0].name, "Local ChatGPT model");
  // Account and API selections share the real conversation/default machinery.
  // All model rows are already cached above; these operations perform no I/O to OpenAI.
  const runner = new TurnRunner({
    profileDir: temp,
    conversationsFile: path.join(temp, "conversations.json"),
    host: {
      call: async () => {
        throw new Error("No host request expected in settings");
      },
    },
  });
  await runner.resume("local-workspace");
  assert.equal(runner.snapshot().customProvider?.id, id);
  await runner.selectModel({ model: "fixture-chatgpt", effort: "medium" });
  await runner.defaultService({ id: api.id });
  assert.equal(
    runner.snapshot().customProvider?.id,
    id,
    "default changes do not move a bound conversation",
  );
  assert.equal(
    (await runner.listModels()).models[0].name,
    "Local ChatGPT model",
  );
  assert.doesNotMatch(
    JSON.stringify(runner.historySnapshot()),
    /local-access|local-refresh|eyJ/,
  );
  await runner.bindService({
    id: api.id,
    conversationId: runner.conversationId!,
    baseUrl: api.baseUrl,
    api: api.api,
  });
  assert.equal(runner.snapshot().customProvider?.id, api.id);
  const savedConversation = await readFile(
    path.join(temp, "conversations.json"),
    "utf8",
  );
  assert.doesNotMatch(
    savedConversation,
    /local-access|local-refresh|local-api-key/,
  );
  await runner.stop();

  await expire();
  await Promise.all([auth.access(id), auth.access(id), auth.access(id)]);
  assert.equal(
    refreshCount,
    1,
    "one rotating refresh across concurrent requests",
  );

  // The same Pi agent used by the product executes a circuit tool and sends its
  // result back in the next Responses request. Includes an image in the input.
  const sdk = await loadSdk();
  const responseTransport = await transport("openai-responses");
  const config = auth.services()[0];
  const sentFetch = chatgptFetch(options.api, () => auth.access(id), fetch);
  let executions = 0;
  const agent = new sdk.Agent({
    initialState: {
      model: modelFor(config),
      systemPrompt: "Inspect the circuit.",
      tools: [
        {
          name: "inspect_circuit",
          label: "Inspect",
          description: "Inspect a circuit",
          parameters: {
            type: "object",
            properties: { circuit: { type: "string" } },
            required: ["circuit"],
          } as any,
          execute: async (_call, args: any) => {
            assert.equal(args.circuit, "main");
            executions++;
            return {
              content: [
                {
                  type: "text",
                  text: "A full adder with eight correct vectors.",
                },
              ],
              details: {},
            };
          },
        },
      ],
    },
    streamFn: (model: any, ctx: any, opts: any) =>
      responseTransport.streamSimple(model, ctx, {
        ...opts,
        apiKey: "chatgpt-session",
        fetch: sentFetch,
        onPayload: chatgptPayload,
        maxRetries: 0,
        maxTokens: 500,
      }),
  });
  await agent.prompt("Inspect main.", [
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  assert.equal(executions, 1);
  assert.equal(payloads.length, 2);
  assert.match(
    JSON.stringify(agent.state.messages.at(-1)),
    /Circuit inspected/,
  );
  assert.match(JSON.stringify(payloads[0].input), /input_image/);
  for (const mode of ["limit", "cut"]) {
    responseMode = mode;
    let attempts = 0;
    const produce = () => {
      attempts++;
      return responseTransport.streamSimple(
        modelFor(config),
        {
          messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
        } as any,
        {
          apiKey: "chatgpt-session",
          fetch: sentFetch,
          onPayload: chatgptPayload,
          maxRetries: 0,
        },
      );
    };
    const output =
      mode === "limit"
        ? retryingStream(produce, sdk, undefined, {
            scheduled: () => {},
            started: () => {},
          })
        : await produce();
    const result = await output.result();
    assert.equal(result.stopReason, "error");
    assert.equal(attempts, 1);
    assert.match(
      result.errorMessage!,
      mode === "limit"
        ? /subscription_sharing_usage_limit_exceeded/
        : /terminal/,
    );
  }
  assert.equal(chatgptPayload({ input: [] }).temperature, undefined); // payload is safe without tools
  await assert.rejects(
    sentFetch("https://unrelated.invalid/responses"),
    /地址无效/,
  );

  const before = await readFile(accountsFile, "utf8");
  badNonce = true;
  const invalid = await auth.begin(id);
  assert.equal(new URL(invalid.url).searchParams.get("client_id"), clientId);
  assert.equal(new URL(invalid.url).searchParams.has("agent_name_hint"), false);
  assert.equal(new URL(invalid.url).searchParams.has("id_token_hint"), false);
  assert.equal((await finish(invalid)).status, "error");
  assert.equal(
    await readFile(accountsFile, "utf8"),
    before,
    "bad nonce preserves active credentials",
  );
  badNonce = false;
  subject = "different-subject";
  assert.equal((await finish(await auth.begin(id))).status, "error");
  assert.equal(
    await readFile(accountsFile, "utf8"),
    before,
    "different identity cannot replace account",
  );
  subject = "local-subject";
  const cancel = await auth.begin();
  auth.cancel(cancel.attemptId);
  assert.equal(auth.status(cancel.attemptId).status, "cancelled");
  const fast = new ChatGPTAccounts(temp, { ...options, loginTimeoutMs: 20 });
  const timeout = await fast.begin();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fast.status(timeout.attemptId).status, "error");
  await expire();
  refreshError = "temporary";
  await assert.rejects(auth.access(id));
  assert.equal(auth.services()[0].account?.connected, true);
  refreshError = "invalid_grant";
  await assert.rejects(auth.access(id), /重新登录/);
  assert.equal(auth.services()[0].account?.connected, false);
  assert.equal(
    configurationIssue(selectionFor(config), auth.services()[0], true)?.code,
    "chatgpt-login",
  );
  refreshError = "";
  scope = "openid offline_access";
  assert.equal((await finish(await auth.begin(id))).status, "complete");
  await assert.rejects(auth.access(id), /授权使用/);
  assert.equal(auth.services()[0].account?.planEnabled, false);
  scope = "openid resource.invoke chatgpt.tokens.use.direct offline_access";
  const enable = await auth.begin(id, true);
  assert.equal(new URL(enable.url).searchParams.get("prompt"), "consent");
  assert.equal((await finish(enable)).welcome, false);
  assert.deepEqual(await auth.logout(id), { warning: null });
  assert.equal(forms.at(-1)?.get("token_type_hint"), "refresh_token");
  assert.equal(auth.services()[0].account?.connected, false);
  assert.equal(
    new URL((await auth.begin(id)).url).searchParams.get("ext_agent_host_id"),
    start.searchParams.get("ext_agent_host_id"),
  );
  auth.cancel();
  await finish(await auth.begin(id));
  revokeError = true;
  assert.match((await auth.logout(id)).warning!, /未确认远端撤销/);
  assert.equal(auth.services()[0].account?.connected, false);
  assert.equal(store.read(api.id)?.apiKey, "local-api-key");
  clientId = "oaiapp_second_workspace";
  const another = await finish(await auth.begin());
  assert.equal(another.status, "complete");
  assert.notEqual(another.serviceId, id);
  assert.equal(
    auth.services().length,
    2,
    "same-email registrations remain separate by issued client and subject",
  );
  assert.equal(
    auth.services().find((s) => s.id === id)?.account?.connected,
    false,
  );
  assert.equal(
    auth.services().find((s) => s.id === another.serviceId)?.account?.connected,
    true,
  );
  assert.deepEqual(serverErrors, []);
  console.log(
    "Verified local ChatGPT OAuth, identity/permission checks, restart, rotating refresh, logout, Responses circuit-tool round trip, images, usage limits and interrupted streams. No real model calls.",
  );
} finally {
  auth.cancel();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
