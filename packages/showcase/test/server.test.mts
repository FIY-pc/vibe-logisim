import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createShowcaseServer, passwordHash } from "../src/server.mts";
test("public feedback requires consent, moderation, administrator ownership, and persistent visibility controls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vibe-showcase-"));
  const options = {
    database: path.join(directory, "site.sqlite"),
    publicDir: path.resolve("packages/showcase/public"),
    adminUsername: "admin",
    adminPasswordHash: passwordHash("test-only-password"),
    ipSecret: "test-only-private-IP-hash-secret-0123456789",
  };
  let app = createShowcaseServer(options),
    base = "",
    cookie = "";
  const listen = async () => {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as any).port}/vibe-logisim`;
  };
  await listen();
  const call = async (
    route: string,
    method = "GET",
    body?: unknown,
    auth = false,
    status = 200,
    origin?: string,
  ) => {
    const r = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(auth ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = (await r.json()) as any;
    assert.equal(r.status, status, JSON.stringify(d));
    return { d, r };
  };
  try {
    const html = await fetch(base + "/");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Windows 课堂版/);
    assert.match(
      html.headers.get("content-security-policy")!,
      /script-src 'self'/,
    );
    await call("/api/admin/comments", "GET", undefined, false, 401);
    const input = {
      author: "同学A",
      role: "student",
      content: "电路很清楚，希望说明连接方式。<script>alert(1)</script>",
      rating: 4,
    };
    await call("/api/comments", "POST", input, false, 400);
    await call(
      "/api/comments",
      "POST",
      { ...input, consent: true },
      false,
      403,
      "https://untrusted.example",
    );
    const pending = (
      await call(
        "/api/comments",
        "POST",
        { ...input, consent: true, source: "editorial" },
        false,
        201,
      )
    ).d;
    assert.equal(pending.status, "pending");
    assert.equal((await call("/api/comments")).d.total, 0);
    await call(
      "/api/admin/login",
      "POST",
      { username: "admin", password: "incorrect" },
      false,
      401,
    );
    const login = await call("/api/admin/login", "POST", {
      username: "admin",
      password: "test-only-password",
    });
    cookie = login.r.headers.get("set-cookie")!.split(";")[0];
    assert.match(login.r.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(login.r.headers.get("set-cookie")!, /SameSite=Strict/);
    const queue = (await call("/api/admin/comments", "GET", undefined, true)).d;
    for (const offset of ["0.5", "NaN", "Infinity", "-1", "100001"]) {
      await call(
        "/api/comments?offset=" + offset,
        "GET",
        undefined,
        false,
        400,
      );
      await call(
        "/api/admin/comments?offset=" + offset,
        "GET",
        undefined,
        true,
        400,
      );
    }
    assert.equal(queue.comments[0].source, "visitor");
    assert.ok(!JSON.stringify(queue).includes("ip_hash"));
    await call(
      "/api/admin/comments/" + pending.id,
      "PATCH",
      { status: "published", reply: "感谢，已补充说明。" },
      true,
    );
    const visible = (await call("/api/comments")).d;
    assert.equal(visible.total, 1);
    assert.equal(visible.comments[0].reply, "感谢，已补充说明。");
    assert.ok(!JSON.stringify(visible).includes("ip_hash"));
    await call(
      "/api/admin/comments/" + pending.id,
      "PATCH",
      { status: "hidden" },
      true,
    );
    assert.equal((await call("/api/comments")).d.total, 0);
    await call(
      "/api/admin/comments/" + pending.id,
      "PATCH",
      { status: "published" },
      true,
    );
    await call(
      "/api/admin/settings",
      "PATCH",
      { commentsVisible: false, postingEnabled: true },
      true,
    );
    const hidden = (await call("/api/comments")).d;
    assert.equal(hidden.commentsVisible, false);
    assert.equal(hidden.comments.length, 0);
    await call(
      "/api/comments",
      "POST",
      { ...input, consent: true },
      false,
      403,
    );
    await call(
      "/api/admin/settings",
      "PATCH",
      { commentsVisible: true, postingEnabled: false },
      true,
    );
    await call(
      "/api/comments",
      "POST",
      { ...input, consent: true },
      false,
      403,
    );
    const manual = (
      await call(
        "/api/admin/comments",
        "POST",
        { author: "项目组", content: "已改进说明", source: "visitor" },
        true,
        201,
      )
    ).d.comment;
    assert.equal(manual.source, "editorial");
    await call(
      "/api/admin/settings",
      "PATCH",
      { commentsVisible: true, postingEnabled: true },
      true,
    );
    await app.close();
    assert.ok(
      !(await readFile(options.database)).includes(
        Buffer.from("test-only-password"),
      ),
    );
    app = createShowcaseServer(options);
    await listen();
    assert.equal((await call("/api/comments")).d.total, 2);
    await call("/api/admin/logout", "POST", {}, true);
    await call("/api/admin/me", "GET", undefined, true, 401);
    const traversal = await fetch(base + "/%2e%2e/%2e%2e/package.json");
    assert.equal(traversal.status, 404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("publication validates content, blocks spam and rate-limits authentication", async () => {
  const app = createShowcaseServer({
    database: ":memory:",
    publicDir: path.resolve("packages/showcase/public"),
    adminUsername: "admin",
    adminPasswordHash: passwordHash("correct-password"),
    ipSecret: "private-test-hash-secret-0123456789012345",
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = (route: string, body: unknown) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await post("/api/comments", {
          author: "x",
          content: "spam",
          website: "bot",
          consent: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/comments", {
          author: "x",
          content: "x".repeat(1501),
          consent: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/comments", {
          author: "x",
          content: "test",
          rating: 9,
          consent: true,
        })
      ).status,
      400,
    );
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await post("/api/admin/login", {
            username: "admin",
            password: "incorrect",
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await post("/api/admin/login", {
          username: "admin",
          password: "correct-password",
        })
      ).status,
      429,
    );
  } finally {
    await app.close();
  }
});

test("public downloads stream exact bytes and support HEAD and resumable ranges", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vibe-download-"));
  const bytes = Buffer.from("PK-download-test-0123456789");
  await writeFile(path.join(directory, "build.zip"), bytes);
  const app = createShowcaseServer({
    database: ":memory:",
    publicDir: path.resolve("packages/showcase/public"),
    downloadsDir: directory,
    adminUsername: "admin",
    adminPasswordHash: passwordHash("test-password"),
    ipSecret: "download-test-private-hash-012345678901234",
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(app.server.address() as any).port}/vibe-logisim/downloads/build.zip`;
  try {
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), bytes.length);
    assert.match(head.headers.get("content-disposition")!, /attachment/);
    const full = await fetch(url);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const range = await fetch(url, { headers: { Range: "bytes=2-7" } });
    assert.equal(range.status, 206);
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      bytes.subarray(2, 8),
    );
    const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(
      Buffer.from(await suffix.arrayBuffer()),
      bytes.subarray(-4),
    );
    const invalid = await fetch(url, { headers: { Range: "bytes=999-" } });
    assert.equal(invalid.status, 416);
    assert.equal(
      invalid.headers.get("content-range"),
      `bytes */${bytes.length}`,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { Range: "bytes=1-3", "If-Range": "outdated" },
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(url.replace("build.zip", "secret.env"))).status,
      404,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
