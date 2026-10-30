import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  validate,
  normaliseBaseUrl,
} from "../../agent-runtime/src/models/validate.mts";
import type { ClassroomProvider, TeacherProvider } from "./types.ts";
import { publicText } from "../../agent-runtime/src/models/public-fields.mts";
import { randomUUID } from "node:crypto";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const endpoints: Record<string, string> = {
  "openai-completions": "chat/completions",
  "openai-responses": "responses",
  "anthropic-messages": "messages",
};
export function classroomProviders(db: DatabaseSync, database: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS classroom_providers(class_id TEXT PRIMARY KEY REFERENCES classrooms(id),config TEXT NOT NULL,secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teacher_providers(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL REFERENCES users(id),config TEXT NOT NULL,secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS classroom_provider_tokens(token TEXT PRIMARY KEY,class_id TEXT NOT NULL REFERENCES classrooms(id),student_id TEXT NOT NULL REFERENCES users(id),UNIQUE(class_id,student_id));`);
  let key: Buffer;
  if (database === ":memory:") key = randomBytes(32);
  else {
    const file = database + ".ai-key";
    try {
      key = readFileSync(file);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      if (
        (
          db
            .prepare(
              "SELECT (SELECT count(*) FROM classroom_providers)+(SELECT count(*) FROM teacher_providers) n",
            )
            .get() as any
        ).n
      )
        throw new Error("课堂 AI 加密密钥缺失，请从备份恢复 .ai-key 文件");
      key = randomBytes(32);
      writeFileSync(file, key, { flag: "wx", mode: 0o600 });
    }
  }
  if (key.length !== 32) throw new Error("课堂 AI 加密密钥无效");
  const encrypt = (plain: string) => {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, iv),
      body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  };
  const decrypt = (secret: string) => {
    const b = Buffer.from(secret, "base64"),
      c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(
      "utf8",
    );
  };
  const row = (id: string) =>
    db.prepare("SELECT * FROM classroom_providers WHERE class_id=?").get(id) as
      { config: string; secret: string } | undefined;
  const visible = (id: string): ClassroomProvider | null => {
    const r = row(id);
    return r ? safe(JSON.parse(r.config), decrypt(r.secret)) : null;
  };
  const safe = (c: ClassroomProvider, secret: string): ClassroomProvider => ({
    name: publicText(c.name, secret),
    baseUrl: publicText(c.baseUrl, secret),
    api: c.api,
    model: publicText(c.model, secret),
    effort: c.effort,
    contextWindow: c.contextWindow,
    vision: c.vision,
    enabled: c.enabled,
    updatedAt: c.updatedAt,
  });
  // Existing classroom configurations become reusable teacher-owned entries without exposing keys.
  db.exec(
    `INSERT OR IGNORE INTO teacher_providers SELECT p.class_id,c.teacher_id,p.config,p.secret FROM classroom_providers p JOIN classrooms c ON c.id=p.class_id;`,
  );
  const active = new Map<string, number>();
  return {
    visible,
    remember(id: string, teacherId: string) {
      const r = row(id);
      if (r)
        db.prepare(
          "INSERT INTO teacher_providers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret=excluded.secret",
        ).run(id, teacherId, r.config, r.secret);
    },
    setEnabled(id: string, enabled: boolean) {
      const r = row(id);
      if (!r) throw new Error("课堂尚未配置模型");
      const c = JSON.parse(r.config);
      db.prepare(
        "UPDATE classroom_providers SET config=? WHERE class_id=?",
      ).run(
        JSON.stringify({ ...c, enabled, updatedAt: new Date().toISOString() }),
        id,
      );
      return visible(id);
    },
    list(teacherId: string): TeacherProvider[] {
      return (
        db
          .prepare(
            "SELECT * FROM teacher_providers WHERE teacher_id=? ORDER BY rowid DESC",
          )
          .all(teacherId) as any[]
      ).map((r) => ({
        ...safe(JSON.parse(r.config), decrypt(r.secret)),
        id: r.id,
      }));
    },
    saveTemplate(teacherId: string, input: any) {
      const previous = input.id
        ? (db
            .prepare(
              "SELECT * FROM teacher_providers WHERE id=? AND teacher_id=?",
            )
            .get(input.id, teacherId) as any)
        : null;
      if (input.id && !previous) throw new Error("模型配置不存在或无权修改");
      const old = previous ? JSON.parse(previous.config) : null;
      if (!endpoints[input.api]) throw new Error("接口协议不支持");
      const config = validate(input, {
        storedApiKey:
          previous &&
          old.baseUrl === normaliseBaseUrl(input.baseUrl) &&
          old.api === input.api
            ? decrypt(previous.secret)
            : null,
      });
      const { apiKey, models: _models, ...rest } = config;
      const value: ClassroomProvider = {
        ...rest,
        api: input.api,
        vision: input.vision === true,
        enabled: true,
        updatedAt: new Date().toISOString(),
      };
      const id = previous?.id || randomUUID();
      db.prepare(
        "INSERT INTO teacher_providers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret=excluded.secret",
      ).run(id, teacherId, JSON.stringify(value), encrypt(apiKey));
      return { ...value, id };
    },
    assign(
      id: string,
      teacherId: string,
      providerId: string,
      enabled: boolean,
    ) {
      const template = db
        .prepare("SELECT * FROM teacher_providers WHERE id=? AND teacher_id=?")
        .get(providerId, teacherId) as any;
      if (!template) throw new Error("模型配置不存在或无权使用");
      const config = JSON.parse(template.config);
      // Validate historical entries too, including keys accidentally placed in model fields.
      validate({ ...config, apiKey: decrypt(template.secret) });
      db.prepare(
        "INSERT INTO classroom_providers VALUES(?,?,?) ON CONFLICT(class_id) DO UPDATE SET config=excluded.config,secret=excluded.secret",
      ).run(
        id,
        JSON.stringify({
          ...config,
          enabled,
          updatedAt: new Date().toISOString(),
        }),
        template.secret,
      );
      return visible(id);
    },
    save(id: string, input: any) {
      if (typeof input.enabled !== "boolean")
        throw new Error("请指定是否向学生开放");
      if (!endpoints[input.api]) throw new Error("接口协议不支持");
      const previous = row(id),
        old = visible(id),
        same =
          old?.baseUrl === normaliseBaseUrl(input.baseUrl) &&
          old.api === input.api;
      const config = validate(input, {
        storedApiKey: previous && same ? decrypt(previous.secret) : null,
      });
      const { apiKey, ...rest } = config;
      const publicConfig: ClassroomProvider = {
        ...rest,
        api: input.api,
        vision: input.vision === true,
        enabled: input.enabled,
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO classroom_providers VALUES(?,?,?) ON CONFLICT(class_id) DO UPDATE SET config=excluded.config,secret=excluded.secret",
      ).run(id, JSON.stringify(publicConfig), encrypt(apiKey));
      return publicConfig;
    },
    issue(id: string, studentId: string) {
      const config = visible(id);
      if (!config?.enabled) throw new Error("教师尚未开放课堂 AI 服务");
      const token = randomBytes(32).toString("hex");
      db.prepare(
        "DELETE FROM classroom_provider_tokens WHERE class_id=? AND student_id=?",
      ).run(id, studentId);
      db.prepare("INSERT INTO classroom_provider_tokens VALUES(?,?,?)").run(
        hash(token),
        id,
        studentId,
      );
      return { config, apiKey: token };
    },
    revoke(id: string) {
      db.prepare("DELETE FROM classroom_provider_tokens WHERE class_id=?").run(
        id,
      );
    },
    revokeStudent(id: string) {
      db.prepare(
        "DELETE FROM classroom_provider_tokens WHERE student_id=?",
      ).run(id);
    },
    async proxy(
      req: IncomingMessage,
      res: ServerResponse,
      id: string,
      endpoint: string,
      readBody: () => Promise<any>,
    ) {
      const error = (status: number, message: string) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { message, type: "classroom_error" } }),
        );
      };
      const token =
        req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ||
        req.headers["x-api-key"];
      if (typeof token !== "string")
        return error(401, "课堂 AI 凭据无效，请重新启用教师配置");
      const member = db
        .prepare(
          `SELECT t.student_id FROM classroom_provider_tokens t JOIN members m ON m.class_id=t.class_id AND m.student_id=t.student_id JOIN classrooms c ON c.id=t.class_id WHERE t.token=? AND t.class_id=? AND c.archived=0`,
        )
        .get(hash(token), id) as any;
      const record = row(id),
        config = visible(id);
      if (!member || !record || !config?.enabled)
        return error(403, "课堂 AI 已停用或授权失效，请重新选择服务");
      if (endpoint === "models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: config.model, object: "model" }],
          }),
        );
        return;
      }
      if (req.method !== "POST" || endpoint !== endpoints[config.api])
        return error(404, "教师未开放这个接口协议");
      const identity = id + ":" + member.student_id;
      if ((active.get(identity) || 0) >= 2)
        return error(429, "同时请求过多，请等待当前回答结束");
      active.set(identity, (active.get(identity) || 0) + 1);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 180000);
      const closed = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", closed);
      try {
        const body = await readBody();
        if (body.model !== config.model)
          return error(409, "教师模型已更新，请重新启用教师配置");
        const secret = decrypt(record.secret);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.api === "anthropic-messages") {
          headers["x-api-key"] = secret;
          headers["anthropic-version"] = "2023-06-01";
        } else headers.Authorization = `Bearer ${secret}`;
        const upstream =
          config.api === "anthropic-messages" && !config.baseUrl.endsWith("/v1")
            ? config.baseUrl + "/v1"
            : config.baseUrl;
        const response = await fetch(upstream + "/" + endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          return error(502, `教师模型服务返回 HTTP ${response.status}`);
        }
        if (!response.body) return error(502, "教师模型服务没有返回内容");
        res.writeHead(200, {
          "Content-Type":
            response.headers.get("content-type") || "application/json",
        });
        await pipeline(Readable.fromWeb(response.body as any), res);
      } catch (cause) {
        if (!res.headersSent && !res.destroyed)
          typeof (cause as any)?.status === "number" &&
          (cause as any).status >= 400 &&
          (cause as any).status < 500
            ? error((cause as any).status, (cause as Error).message)
            : error(502, "教师模型连接失败或超时，请稍后重试");
        else if (!res.destroyed) res.destroy();
      } finally {
        clearTimeout(timer);
        res.off("close", closed);
        const count = (active.get(identity) || 1) - 1;
        if (count) active.set(identity, count);
        else active.delete(identity);
      }
    },
  };
}
