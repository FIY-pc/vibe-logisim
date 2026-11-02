/** ChatGPT plan OAuth for a public native client. Tokens never leave the sidecar.
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createLocalJWKSet, jwtVerify } from "jose";
import { atomic } from "./storage.mts";
import type { ServiceConfig } from "./types.mts";

const ISSUER = "https://auth.openai.com";
export const CHATGPT_API = "https://api.openai.com/v1";
export const CHATGPT_USAGE = "https://chatgpt.com/settings/usage";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
interface Tokens {
  access: string;
  refresh: string;
  identity: string;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt: number;
}
interface Account {
  id: string;
  clientId: string;
  subject: string;
  email: string;
  tokens?: Tokens;
  models: ChatGPTModel[];
  model: string;
  effort: ServiceConfig["effort"];
  welcomed: boolean;
}
export interface ChatGPTModel {
  model: string;
  name: string;
  defaultEffort: string;
  efforts: { value: string }[];
  metadata: { contextWindow: number; vision: boolean; source: string };
}
interface Saved {
  version: 1;
  hostId: string;
  accounts: Account[];
}
type LoginState = {
  attemptId: string;
  status: "pending" | "complete" | "error" | "cancelled";
  serviceId?: string;
  error?: string;
  welcome?: boolean;
};
interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  redirect: string;
  account?: Account;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  consumed: boolean;
  result: LoginState;
}
interface Options {
  fetchFor: (url: string) => Promise<typeof fetch>;
  changed: () => void;
  /** Only injected by local tests; production endpoints are fixed. */
  issuer?: string;
  api?: string;
  loginTimeoutMs?: number;
}
const random = () => randomBytes(32).toString("base64url");
const planEnabled = (a: Account) =>
  Boolean(
    a.tokens?.scopes.includes("chatgpt.tokens.use.direct") &&
    a.tokens.scopes.includes("resource.invoke"),
  );

export class ChatGPTAccounts {
  private readonly file: string;
  private readonly issuer: string;
  readonly api: string;
  private attempt?: Attempt;
  private refreshing = new Map<string, Promise<string>>();
  private readonly options: Options;
  constructor(profileDir: string, options: Options) {
    this.options = options;
    this.file = path.join(profileDir, "chatgpt-accounts.json");
    this.issuer = options.issuer || ISSUER;
    this.api = options.api || CHATGPT_API;
  }
  private read(): Saved {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        saved.version !== 1 ||
        !saved.hostId ||
        !Array.isArray(saved.accounts)
      )
        throw new Error();
      return saved;
    } catch (e: any) {
      if (e.code !== "ENOENT")
        throw new Error("ChatGPT 登录记录无法读取，原文件已保留");
      return { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
    }
  }
  private account(id: string) {
    const account = this.read().accounts.find((a) => a.id === id);
    if (!account) throw new Error("ChatGPT 账号不存在");
    return account;
  }
  private save(account: Account) {
    const saved = this.read();
    saved.accounts = [
      ...saved.accounts.filter((a) => a.id !== account.id),
      account,
    ];
    atomic(this.file, saved);
    this.options.changed();
  }
  services(): ServiceConfig[] {
    return this.read().accounts.map((a) => ({
      id: a.id,
      name: `ChatGPT · ${a.email || "账号"} · ${a.id.slice(-6)}`,
      baseUrl: this.api,
      api: "openai-responses",
      apiKey: "",
      auth: "chatgpt",
      model: a.model,
      models: a.models.map((m) => m.model),
      effort: a.effort,
      contextWindow:
        a.models.find((m) => m.model === a.model)?.metadata.contextWindow ||
        128000,
      vision:
        a.models.find((m) => m.model === a.model)?.metadata.vision ?? true,
      account: {
        email: a.email,
        connected: Boolean(a.tokens),
        planEnabled: planEnabled(a),
      },
    }));
  }
  private async request(url: string, init: RequestInit = {}) {
    const request = await this.options.fetchFor(url);
    return request(url, {
      ...init,
      redirect: "error",
      signal: init.signal || AbortSignal.timeout(20000),
    });
  }
  private async json(url: string, init: RequestInit = {}) {
    const response = await this.request(url, init);
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `ChatGPT 返回了无法读取的响应（HTTP ${response.status}）`,
      );
    }
    if (!response.ok) {
      // Do not echo an authentication response body: it may contain credentials.
      const rawCode =
        typeof body.error === "string" ? body.error : body.error?.code;
      const code =
        typeof rawCode === "string" && /^[a-z_]{1,100}$/.test(rawCode)
          ? rawCode
          : "request_failed";
      throw Object.assign(
        new Error(`ChatGPT 请求失败（HTTP ${response.status}，${code}）`),
        { code, status: response.status },
      );
    }
    return body;
  }
  private async discovery() {
    const value = await this.json(
      `${this.issuer}/.well-known/openid-configuration`,
    );
    if (value.issuer !== this.issuer) throw new Error("ChatGPT 身份服务不匹配");
    for (const field of ["jwks_uri", "revocation_endpoint"]) {
      if (new URL(value[field]).origin !== this.issuer)
        throw new Error("ChatGPT 身份服务地址无效");
    }
    return value;
  }
  private async identity(token: string, clientId: string, nonce?: string) {
    const discovery = await this.discovery();
    const jwks = await this.json(discovery.jwks_uri);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: this.issuer,
      audience: clientId,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "exp", "iat", ...(nonce ? ["nonce"] : [])],
    }).catch(() => {
      throw new Error("ChatGPT 身份校验失败，请重新登录");
    });
    if (!payload.sub || (nonce && payload.nonce !== nonce))
      throw new Error("ChatGPT 登录状态不匹配，请重新登录");
    return {
      subject: payload.sub,
      email:
        typeof payload.email === "string" ? payload.email.slice(0, 160) : "",
    };
  }
  private tokens(body: any, previous?: Tokens): Tokens {
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.refresh_token !== "string" ||
      !body.refresh_token ||
      body.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(body.expires_in) ||
      body.expires_in <= 0
    ) {
      throw new Error("ChatGPT 登录凭据不完整，请重新登录");
    }
    return {
      access: body.access_token,
      refresh: body.refresh_token,
      identity: body.id_token || previous?.identity || "",
      scopes:
        typeof body.scope === "string"
          ? body.scope.split(/\s+/)
          : previous?.scopes || [],
      expiresAt: Date.now() + body.expires_in * 1000,
      earliestRefreshAt: Number(body.earliest_refresh_at || 0) * 1000,
    };
  }
  async begin(id?: string, consent = false) {
    this.cancel();
    const saved = this.read();
    atomic(this.file, saved); // Persist the host ID before first authorization.
    const account = id ? this.account(id) : undefined;
    const server = createServer((req, res) => {
      void this.callback(req.url || "", req.method, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("无法开启登录回调");
    const result: LoginState = { attemptId: randomUUID(), status: "pending" };
    const attempt: Attempt = {
      state: random(),
      nonce: random(),
      verifier: random(),
      account,
      server,
      redirect: `http://127.0.0.1:${address.port}/auth/callback`,
      consumed: false,
      controller: new AbortController(),
      result,
      timer: setTimeout(
        () =>
          this.finish(attempt, {
            status: "error",
            error: "登录已超时，请重试",
          }),
        this.options.loginTimeoutMs || 5 * 60_000,
      ),
    };
    this.attempt = attempt;
    const url = new URL(`${this.issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: account?.clientId || "dynamic_agent_client",
      ...(account ? {} : { agent_name_hint: "Vibe Logisim" }),
      ext_agent_host_id: saved.hostId,
      response_type: "code",
      redirect_uri: attempt.redirect,
      scope: SCOPES,
      resource: this.api,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(attempt.verifier)
        .digest("base64url"),
      ...(account?.email ? { login_hint: account.email } : {}),
      ...(consent ? { prompt: "consent" } : {}),
    }).toString();
    return { ...result, url: url.href };
  }
  private finish(attempt: Attempt, next: Partial<LoginState>) {
    if (attempt.result.status !== "pending") return;
    Object.assign(attempt.result, next);
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.server.close();
  }
  cancel(id?: string) {
    if (this.attempt && (!id || id === this.attempt.result.attemptId))
      this.finish(this.attempt, { status: "cancelled" });
  }
  status(id: string): LoginState {
    if (this.attempt?.result.attemptId !== id)
      throw new Error("登录已结束，请重新开始");
    return { ...this.attempt.result };
  }
  private async callback(
    raw: string,
    method: string | undefined,
    res: import("node:http").ServerResponse,
  ) {
    const a = this.attempt;
    const url = new URL(raw, "http://127.0.0.1");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (
      !a ||
      method !== "GET" ||
      url.pathname !== "/auth/callback" ||
      a.result.status !== "pending" ||
      a.consumed ||
      url.searchParams.get("state") !== a.state
    ) {
      res.writeHead(400).end("登录回调无效，请回到 Vibe Logisim 重试。");
      return;
    }
    a.consumed = true;
    try {
      if (url.searchParams.has("error"))
        throw new Error("未完成 ChatGPT 授权，你可以重试或选择 API 服务");
      const clientId = url.searchParams.get("client_id") || a.account?.clientId;
      const code = url.searchParams.get("code");
      if (
        !clientId ||
        clientId === "dynamic_agent_client" ||
        !code ||
        (a.account && a.account.clientId !== clientId)
      )
        throw new Error("ChatGPT 注册信息不匹配，请重新登录");
      const body = await this.json(`${this.issuer}/api/accounts/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: a.verifier,
          redirect_uri: a.redirect,
          resource: this.api,
        }),
        signal: AbortSignal.any([
          a.controller.signal,
          AbortSignal.timeout(20000),
        ]),
      });
      const identity = await this.identity(body.id_token, clientId, a.nonce);
      if (a.account && a.account.subject !== identity.subject)
        throw new Error("登录的账号与所选账号不同，请使用添加账号");
      const existing = this.read().accounts.find(
        (c) => c.clientId === clientId,
      );
      if (existing && existing.subject !== identity.subject)
        throw new Error("ChatGPT 注册身份不匹配");
      const account: Account = {
        id: existing?.id || `chatgpt-${randomUUID()}`,
        clientId,
        ...identity,
        tokens: this.tokens(body),
        models: existing?.models || [],
        model: existing?.model || "",
        effort: existing?.effort || "none",
        welcomed: existing?.welcomed || false,
      };
      if (a.result.status !== "pending") throw new Error("登录已取消");
      if (planEnabled(account)) {
        try {
          account.models = await this.fetchModels(account.tokens!.access);
        } catch {
          /* The model picker offers a retry; identity remains signed in. */
        }
        if (!account.model && account.models.length) {
          account.model = account.models[0].model;
          account.effort = account.models[0]
            .defaultEffort as ServiceConfig["effort"];
        }
      }
      if (a.result.status !== "pending") throw new Error("登录已取消");
      this.save(account);
      res.end("已登录 ChatGPT。请回到 Vibe Logisim 继续。");
      this.finish(a, {
        status: "complete",
        serviceId: account.id,
        welcome: planEnabled(account) && !account.welcomed,
      });
    } catch (e: any) {
      res
        .writeHead(400)
        .end("未完成登录。请回到 Vibe Logisim 查看详情并重试。");
      this.finish(a, { status: "error", error: e.message });
    }
  }
  /** The host holds an OS lock on its state directory. One sidecar owns these
   * records; this promise serializes rotating refreshes within that process. */
  access(id: string): Promise<string> {
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const task = this.accessNow(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, task);
    return task;
  }
  private async accessNow(id: string) {
    const a = this.account(id),
      t = a.tokens;
    if (!t) throw new Error("请在 AI 设置中重新登录 ChatGPT");
    if (!planEnabled(a))
      throw new Error(
        "请在 AI 设置中授权使用 ChatGPT 订阅额度，或选择 API 服务",
      );
    if (
      t.expiresAt > Date.now() + 60_000 ||
      (t.expiresAt > Date.now() && t.earliestRefreshAt > Date.now())
    )
      return t.access;
    try {
      const body = await this.json(`${this.issuer}/api/accounts/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: a.clientId,
          refresh_token: t.refresh,
          resource: this.api,
        }),
      });
      if (body.id_token) {
        const identity = await this.identity(body.id_token, a.clientId);
        if (identity.subject !== a.subject)
          throw new Error("ChatGPT 刷新身份不匹配");
      }
      a.tokens = this.tokens(body, t);
      this.save(a);
      if (!planEnabled(a))
        throw new Error("ChatGPT 订阅授权已关闭，请在 AI 设置中重新授权");
      return a.tokens.access;
    } catch (e: any) {
      if (TERMINAL_REFRESH.has(e.code)) {
        delete a.tokens;
        this.save(a);
        throw new Error("ChatGPT 登录已失效，请在 AI 设置中重新登录");
      }
      throw e;
    }
  }
  async models(id: string, refresh = false): Promise<ChatGPTModel[]> {
    const a = this.account(id);
    if (!refresh && a.models.length) return a.models;
    const token = await this.access(id);
    const models = await this.fetchModels(token);
    const latest = this.account(id); // A refresh may have rotated tokens above.
    latest.models = models;
    if (!latest.model && models.length) {
      latest.model = models[0].model;
      latest.effort = models[0].defaultEffort as ServiceConfig["effort"];
    }
    this.save(latest);
    return models;
  }
  private async fetchModels(token: string): Promise<ChatGPTModel[]> {
    const body = await this.json(`${this.api}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!Array.isArray(body.models))
      throw new Error("ChatGPT 未返回账号模型列表，请刷新重试");
    return body.models
      .filter((m: any) => m.visibility === "list" && typeof m.slug === "string")
      .map((m: any) => ({
        model: m.slug,
        name: m.display_name || m.slug,
        defaultEffort: m.default_reasoning_level || "none",
        efforts: [
          { value: "none" },
          ...(m.supported_reasoning_levels || []).map((r: any) => ({
            value: typeof r === "string" ? r : r.effort,
          })),
        ],
        metadata: {
          contextWindow:
            Number.isSafeInteger(m.context_window) && m.context_window > 0
              ? m.context_window
              : 128000,
          vision:
            !Array.isArray(m.input_modalities) ||
            m.input_modalities.includes("image"),
          source: "ChatGPT 账号",
        },
      }));
  }
  select(id: string, model: string, effort: ServiceConfig["effort"]) {
    const a = this.account(id);
    if (!a.models.some((m) => m.model === model))
      throw new Error("请选择 ChatGPT 账号可用的模型");
    a.model = model;
    a.effort = effort;
    this.save(a);
  }
  welcome(id: string) {
    const a = this.account(id);
    a.welcomed = true;
    this.save(a);
  }
  async logout(id: string) {
    this.cancel();
    await this.refreshing.get(id)?.catch(() => {});
    const a = this.account(id);
    let warning: string | null = null;
    if (a.tokens?.refresh) {
      try {
        const discovery = await this.discovery();
        const response = await this.request(discovery.revocation_endpoint, {
          method: "POST",
          body: new URLSearchParams({
            token: a.tokens.refresh,
            token_type_hint: "refresh_token",
            client_id: a.clientId,
          }),
        });
        if (!response.ok) throw new Error();
      } catch {
        warning =
          "已退出本机账号，但未确认远端撤销。可在 ChatGPT 设置中断开此应用。";
      }
    }
    delete a.tokens;
    this.save(a);
    return { warning };
  }
}
