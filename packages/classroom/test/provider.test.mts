import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClassroomServer } from "../src/server.mts";
import { modelFor, transport } from "../../agent-runtime/src/models/services.mts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

test("teacher AI distribution proxies three protocols, encrypts keys, revokes access and preserves personal services", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "classroom-provider-"));
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    requests.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(raw),
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({id:"chatcmpl-test",object:"chat.completion.chunk",created:0,model:"model-a",choices:[{index:0,delta:{role:"assistant",content:"hello"},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:"chatcmpl-test",object:"chat.completion.chunk",created:0,model:"model-a",choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const database = path.join(directory, "data.sqlite"),
    options = { database, teacherCode: "teacher-code" };
  let app = createClassroomServer(options),
    base = "";
  const listen = async () => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  };
  await listen();
  const call = async (
    route: string,
    token: string,
    body?: unknown,
    status = 200,
  ) => {
    const r = await fetch(base + "/api" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await r.json()) as any;
    assert.equal(r.status, status, JSON.stringify(data));
    return data;
  };
  const register = (username: string, role = "student") =>
    call(
      "/auth/register",
      "",
      {
        username,
        role,
        name: username,
        studentNo: username,
        password: "test-password",
        teacherCode: "teacher-code",
      },
      201,
    );
  try {
    const teacher = await register("teacher", "teacher"),
      other = await register("other", "teacher"),
      student = await register("student"),
      outsider = await register("outsider");
    const c = (
      await call("/classrooms", teacher.token, { title: "Class" }, 201)
    ).classroom;
    await call("/classrooms/join", student.token, { code: c.code });
    const config = {
      name: "Class AI",
      baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
      api: "openai-completions",
      apiKey: "sk-real-teacher-secret",
      model: "model-a",
      effort: "none",
      contextWindow: 128000,
      vision: true,
      enabled: true,
    };
    await call(`/classrooms/${c.id}/ai`, student.token, config, 403);
    await call(`/classrooms/${c.id}/ai`, other.token, config, 404);
    await call(`/classrooms/${c.id}/ai`, teacher.token, config);
    const detail = await call(`/classrooms/${c.id}`, student.token);
    assert.ok(!JSON.stringify(detail).includes(config.apiKey));
    assert.equal(detail.provider.model, "model-a");
    await call(`/classrooms/${c.id}/ai/access`, outsider.token, {}, 404);
    let access = await call(`/classrooms/${c.id}/ai/access`, student.token, {});
    assert.notEqual(access.apiKey, config.apiKey);
    const proxy = (
      key: string,
      endpoint = "chat/completions",
      body: any = { model: "model-a", stream: true },
    ) =>
      fetch(`${base}/api/classrooms/${c.id}/ai/v1/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let response = await proxy(access.apiKey);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello/);
    assert.equal(requests[0].headers.authorization, `Bearer ${config.apiKey}`);
    assert.equal(requests[0].path, "/v1/chat/completions");
    const sdk=await transport("openai-completions");
    const runtimeConfig={...config,baseUrl:`${base}/api/classrooms/${c.id}/ai/v1`,apiKey:access.apiKey};
    const stream=await sdk.streamSimple(modelFor(runtimeConfig as any),normalizeContext({messages:[{role:"user",content:"hello",timestamp:Date.now()}]}), {apiKey:access.apiKey,fetch:globalThis.fetch});
    const reply=await stream.result();
    assert.equal(reply.stopReason,"stop",reply.errorMessage);
    assert.ok(reply.content.some((part:any)=>part.type==="text" && part.text==="hello"),"real agent SDK consumes the classroom stream");
    assert.equal(
      (await proxy(student.token)).status,
      403,
      "login tokens cannot be used as model credentials",
    );
    assert.equal(
      (await proxy(access.apiKey, "chat/completions", { model: "forbidden" }))
        .status,
      409,
    );
    const previousKey = access.apiKey;
    access = await call(`/classrooms/${c.id}/ai/access`, student.token, {});
    assert.equal((await proxy(previousKey)).status, 403);
    await call(`/classrooms/${c.id}/ai`, teacher.token, {
      ...config,
      apiKey: "",
      enabled: false,
    });
    assert.equal((await proxy(access.apiKey)).status, 403);
    await call(`/classrooms/${c.id}/ai`, teacher.token, {
      ...config,
      apiKey: "",
    });
    response = await proxy(access.apiKey);
    assert.equal(response.status, 200);
    await response.text();
    await call(`/classrooms/${c.id}/ai/revoke`, teacher.token, {});
    assert.equal((await proxy(access.apiKey)).status, 403);
    for (const api of ["openai-responses", "anthropic-messages"]) {
      await call(`/classrooms/${c.id}/ai`, teacher.token, { ...config, api });
      access = await call(`/classrooms/${c.id}/ai/access`, student.token, {});
      response = await proxy(
        access.apiKey,
        api === "openai-responses" ? "responses" : "v1/messages",
      );
      assert.equal(response.status, 200);
      await response.text();
      const last = requests.at(-1);
      assert.equal(
        last.path,
        api === "openai-responses" ? "/v1/responses" : "/v1/messages",
      );
      if (api === "anthropic-messages") {
        assert.equal(last.headers["x-api-key"], config.apiKey);
        assert.equal(last.headers.authorization, undefined);
      }
    }
    await app.close();
    assert.ok(
      !(await readFile(database)).includes(Buffer.from(config.apiKey)),
      "real key is encrypted on disk",
    );
    app = createClassroomServer(options);
    await listen();
    response = await proxy(access.apiKey, "messages");
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await app.close();
    upstream.closeIdleConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
