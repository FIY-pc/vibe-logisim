import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export const passwordHash = (
  password: string,
  salt = randomBytes(16).toString("hex"),
) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
export interface SiteOptions {
  database: string;
  publicDir: string;
  downloadsDir?: string;
  adminUsername: string;
  adminPasswordHash: string;
  ipSecret: string;
  origin?: string;
  secureCookies?: boolean;
  trustProxy?: boolean;
}
class Failure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (status: number, message: string): never => {
  throw new Failure(status, message);
};
const text = (v: unknown, max: number, label: string) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail(400, `${label}不能为空且不能超过${max}字`);
  return (v as string).trim();
};
export function createShowcaseServer(options: SiteOptions) {
  if (
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(options.adminPasswordHash) ||
    options.ipSecret.length < 32
  )
    throw new Error("Invalid private administrator configuration");
  const db = new DatabaseSync(options.database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS site_settings(id INTEGER PRIMARY KEY CHECK(id=1),visible INTEGER NOT NULL DEFAULT 1,posting INTEGER NOT NULL DEFAULT 1);
    INSERT OR IGNORE INTO site_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,author TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,rating INTEGER,source TEXT NOT NULL,status TEXT NOT NULL,reply TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,ip_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS comments_public ON comments(status,created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,comment_id TEXT,created_at TEXT NOT NULL);`);
  const settings = () => {
    const r = db.prepare("SELECT * FROM site_settings WHERE id=1").get() as any;
    return {
      commentsVisible: Boolean(r.visible),
      postingEnabled: Boolean(r.posting),
    };
  };
  const present = (r: any) => ({
    id: r.id,
    author: r.author,
    role: r.role,
    content: r.content,
    rating: r.rating,
    source: r.source,
    status: r.status,
    reply: r.reply,
    createdAt: r.created_at,
  });
  const audit = (action: string, id: string | null = null) =>
    db
      .prepare("INSERT INTO audit(action,comment_id,created_at) VALUES(?,?,?)")
      .run(action, id, new Date().toISOString());
  const ipHash = (req: IncomingMessage) => {
    const remote = req.socket.remoteAddress || "unknown";
    const forwarded =
      options.trustProxy &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
        ? req.headers["x-real-ip"]
        : undefined;
    return createHmac("sha256", options.ipSecret)
      .update(typeof forwarded === "string" ? forwarded : remote)
      .digest("hex");
  };
  const attempts = new Map<string, { count: number; until: number }>();
  function limit(key: string, max: number, window: number) {
    const time = Date.now();
    let v = attempts.get(key);
    if (!v || v.until <= time) {
      if (attempts.size >= 10000)
        for (const [k, r] of attempts) if (r.until <= time) attempts.delete(k);
      if (attempts.size >= 10000) fail(429, "请求较多，请稍后重试");
      v = { count: 0, until: time + window };
      attempts.set(key, v);
    }
    if (++v.count > max) fail(429, "操作过于频繁，请稍后重试");
  }
  async function body(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      fail(415, "请使用JSON请求");
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 8192) fail(413, "请求内容过长");
      chunks.push(chunk);
    }
    try {
      const b = JSON.parse(Buffer.concat(chunks).toString());
      if (!b || Array.isArray(b) || typeof b !== "object")
        fail(400, "请求无效");
      return b;
    } catch (e) {
      if (e instanceof Failure) throw e;
      return fail(400, "JSON无效");
    }
  }
  const token = (req: IncomingMessage) =>
    req.headers.cookie?.match(
      /(?:^|;\s*)vibe_site_admin=([a-f0-9]{64})(?:;|$)/,
    )?.[1] || "";
  function admin(req: IncomingMessage) {
    if (
      !db
        .prepare("SELECT 1 FROM admin_sessions WHERE token=? AND expires>?")
        .get(digest(token(req)), Date.now())
    )
      fail(401, "请先登录管理后台");
  }
  function add(input: any, source: "visitor" | "editorial", hash: string) {
    const author = text(input.author, 40, "称呼"),
      content = text(input.content, 1500, "评论");
    const role = ["student", "teacher", "other"].includes(input.role)
      ? input.role
      : "other";
    if (
      input.rating != null &&
      (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
    )
      fail(400, "评分须为1到5");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO comments(id,author,role,content,rating,source,status,created_at,ip_hash) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      author,
      role,
      content,
      input.rating ?? null,
      source,
      source === "editorial" ? "published" : "pending",
      new Date().toISOString(),
      hash,
    );
    return present(db.prepare("SELECT * FROM comments WHERE id=?").get(id));
  }
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      const url = new URL(req.url || "/", "http://showcase.local"),
        route = url.pathname.startsWith("/vibe-logisim/")
          ? url.pathname.slice("/vibe-logisim".length)
          : url.pathname,
        method = req.method;
      if (!["GET", "HEAD"].includes(method || "")) {
        const allowed = options.origin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== allowed)
          fail(403, "来源未获允许");
      }
      if (route === "/api/health" && method === "GET") {
        send(200, { ok: true, service: "vibe-showcase" });
        return;
      }
      if (route === "/api/settings" && method === "GET") {
        send(200, settings());
        return;
      }
      if (route === "/api/comments" && method === "GET") {
        const s = settings();
        const offset = Math.max(
          0,
          Math.min(100000, Number(url.searchParams.get("offset")) || 0),
        );
        const rows = s.commentsVisible
          ? db
              .prepare(
                "SELECT * FROM comments WHERE status='published' ORDER BY created_at DESC,rowid DESC LIMIT 20 OFFSET ?",
              )
              .all(offset)
          : [];
        const total = s.commentsVisible
          ? (
              db
                .prepare(
                  "SELECT count(*) n FROM comments WHERE status='published'",
                )
                .get() as any
            ).n
          : 0;
        send(200, { ...s, comments: rows.map(present), total });
        return;
      }
      if (route === "/api/comments" && method === "POST") {
        const s = settings();
        if (!s.commentsVisible || !s.postingEnabled)
          fail(403, "管理员暂时关闭了评论发布");
        const b = await body(req);
        if (b.website) fail(400, "提交无效");
        if (b.consent !== true) fail(400, "请先同意审核后公开展示本条反馈");
        const ip = ipHash(req);
        limit("comment:" + ip, 6, 60000);
        limit("comment-hour:" + ip, 30, 3600000);
        const item = add(b, "visitor", ip);
        send(201, {
          id: item.id,
          status: "pending",
          message: "已收到反馈，审核通过后公开展示。",
        });
        return;
      }
      if (route === "/api/admin/login" && method === "POST") {
        limit("login:" + ipHash(req), 10, 900000);
        const b = await body(req);
        const supplied =
          typeof b.password === "string" && b.password.length <= 256
            ? b.password
            : "";
        const [salt, expected] = options.adminPasswordHash.split(":");
        const valid = timingSafeEqual(
          scryptSync(supplied, salt, 64),
          Buffer.from(expected, "hex"),
        );
        if (b.username !== options.adminUsername || !valid)
          fail(401, "账号或密码错误");
        db.prepare("DELETE FROM admin_sessions WHERE expires<=?").run(
          Date.now(),
        );
        const session = randomBytes(32).toString("hex");
        db.prepare("INSERT INTO admin_sessions VALUES(?,?)").run(
          digest(session),
          Date.now() + 8 * 3600000,
        );
        res.setHeader(
          "Set-Cookie",
          `vibe_site_admin=${session}; Path=/vibe-logisim/; HttpOnly; SameSite=Strict; Max-Age=28800${options.secureCookies ? "; Secure" : ""}`,
        );
        audit("login");
        send(200, { ok: true });
        return;
      }
      if (route.startsWith("/api/admin/")) {
        admin(req);
        if (route === "/api/admin/me" && method === "GET") {
          send(200, { username: options.adminUsername });
          return;
        }
        if (route === "/api/admin/logout" && method === "POST") {
          db.prepare("DELETE FROM admin_sessions WHERE token=?").run(
            digest(token(req)),
          );
          res.setHeader(
            "Set-Cookie",
            `vibe_site_admin=; Path=/vibe-logisim/; HttpOnly; SameSite=Strict; Max-Age=0${options.secureCookies ? "; Secure" : ""}`,
          );
          send(200, { ok: true });
          return;
        }
        if (route === "/api/admin/settings" && method === "PATCH") {
          const b = await body(req);
          if (
            typeof b.commentsVisible !== "boolean" ||
            typeof b.postingEnabled !== "boolean"
          )
            fail(400, "评论设置无效");
          db.prepare(
            "UPDATE site_settings SET visible=?,posting=? WHERE id=1",
          ).run(Number(b.commentsVisible), Number(b.postingEnabled));
          audit("settings");
          send(200, settings());
          return;
        }
        if (route === "/api/admin/comments" && method === "GET") {
          const status = url.searchParams.get("status") || "pending";
          if (!["pending", "published", "hidden", "all"].includes(status))
            fail(400, "状态无效");
          const offset = Math.max(
            0,
            Math.min(100000, Number(url.searchParams.get("offset")) || 0),
          );
          const rows =
            status === "all"
              ? db
                  .prepare(
                    "SELECT * FROM comments ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?",
                  )
                  .all(offset)
              : db
                  .prepare(
                    "SELECT * FROM comments WHERE status=? ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?",
                  )
                  .all(status, offset);
          send(200, {
            comments: rows.map(present),
            settings: settings(),
            counts: db
              .prepare(
                "SELECT status,count(*) count FROM comments GROUP BY status",
              )
              .all(),
          });
          return;
        }
        if (route === "/api/admin/comments" && method === "POST") {
          const item = add(await body(req), "editorial", ipHash(req));
          audit("editorial-add", item.id);
          send(201, { comment: item });
          return;
        }
        const match = route.match(/^\/api\/admin\/comments\/([a-f0-9-]{36})$/);
        if (match && method === "PATCH") {
          const b = await body(req);
          const old = db
            .prepare("SELECT * FROM comments WHERE id=?")
            .get(match[1]) as any;
          if (!old) fail(404, "评论不存在");
          if (
            b.status !== undefined &&
            !["pending", "published", "hidden"].includes(b.status)
          )
            fail(400, "状态无效");
          if (
            b.reply !== undefined &&
            (typeof b.reply !== "string" || b.reply.length > 1000)
          )
            fail(400, "回复不能超过1000字");
          db.prepare("UPDATE comments SET status=?,reply=? WHERE id=?").run(
            b.status ?? old.status,
            b.reply ?? old.reply,
            match[1],
          );
          audit(b.status ? "status:" + b.status : "reply", match[1]);
          send(200, {
            comment: present(
              db.prepare("SELECT * FROM comments WHERE id=?").get(match[1]),
            ),
          });
          return;
        }
        fail(404, "接口不存在");
      }
      if (route.startsWith("/api/")) fail(404, "接口不存在");
      if (!["GET", "HEAD"].includes(method || "")) fail(405, "方法不支持");
      if (route.startsWith("/downloads/")) {
        if (!options.downloadsDir) fail(404, "下载文件尚未配置");
        const name = route.slice("/downloads/".length);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(exe|zip|txt)$/.test(name))
          fail(404, "下载文件不存在");
        const file = path.join(options.downloadsDir!, name),
          info = await stat(file).catch(() => null);
        if (!info?.isFile()) fail(404, "下载文件不存在");
        const size = info!.size,
          etag = `"${size}-${Math.trunc(info!.mtimeMs)}"`;
        let start = 0,
          end = size - 1,
          partial = false;
        const range = req.headers.range;
        if (
          range &&
          (!req.headers["if-range"] || req.headers["if-range"] === etag)
        ) {
          const match = range.match(/^bytes=(\d*)-(\d*)$/);
          if (!match || (!match[1] && !match[2])) {
            res.setHeader("Content-Range", `bytes */${size}`);
            fail(416, "下载范围无效");
          }
          if (match![1]) {
            start = Number(match![1]);
            end = match![2] ? Math.min(Number(match![2]), size - 1) : end;
          } else start = Math.max(0, size - Number(match![2]));
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start > end ||
            start >= size
          ) {
            res.setHeader("Content-Range", `bytes */${size}`);
            fail(416, "下载范围无效");
          }
          partial = true;
        }
        res.writeHead(partial ? 206 : 200, {
          "Content-Type": name.endsWith(".txt")
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
          "Content-Disposition": `attachment; filename="${name}"`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          ETag: etag,
          "Cache-Control": name.endsWith(".txt")
            ? "no-cache"
            : "public, max-age=31536000, immutable",
          ...(partial
            ? { "Content-Range": `bytes ${start}-${end}/${size}` }
            : {}),
        });
        if (method === "HEAD") {
          res.end();
          return;
        }
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      const relative =
        route === "/"
          ? "index.html"
          : route === "/admin" || route === "/admin/"
            ? "admin.html"
            : decodeURIComponent(route).slice(1);
      const base = path.resolve(options.publicDir),
        file = path.resolve(base, relative);
      if (
        !file.startsWith(base + path.sep) ||
        relative.split(/[\\/]/).some((v) => v.startsWith("."))
      )
        fail(404, "页面不存在");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) fail(404, "页面不存在");
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Content-Length": info!.size,
        "Cache-Control": file.endsWith(".html")
          ? "no-cache"
          : "public, max-age=300",
      });
      res.end(method === "HEAD" ? undefined : await readFile(file));
    } catch (e) {
      if (e instanceof Failure) send(e.status, { error: e.message });
      else {
        console.error(
          "showcase request failed",
          e instanceof Error ? e.name : "unknown",
        );
        send(500, { error: "服务暂时不可用，请稍后重试" });
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      db.close();
    },
  };
}
