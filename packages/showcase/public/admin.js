const $ = (s) => document.querySelector(s);
let offset = 0;
const message = $("#admin-message");
async function api(route, method = "GET", body) {
  const r = await fetch("api/admin/" + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (r.status === 401) {
    $("#dashboard").hidden = true;
    $("#login").hidden = false;
  }
  if (!r.ok) throw Error(d.error || "操作失败");
  return d;
}
function node(tag, content, cls) {
  const el = document.createElement(tag);
  el.textContent = content;
  if (cls) el.className = cls;
  return el;
}
async function action(work) {
  message.textContent = "正在处理…";
  try {
    await work();
    message.textContent = "已保存";
  } catch (e) {
    message.textContent = e.message;
  }
}
function comment(c) {
  const el = document.createElement("article");
  el.className = "comment";
  const header = node("div", "", "comment-heading");
  header.append(
    node("strong", c.author),
    node("span", c.source === "editorial" ? "站方发布" : "访客提交"),
  );
  el.append(
    header,
    node("p", c.content, "comment-content"),
    node(
      "p",
      `${new Date(c.createdAt).toLocaleString("zh-CN")} · ${{ pending: "待审核", published: "已公开", hidden: "已隐藏" }[c.status]}${c.rating ? " · " + c.rating + "/5 分" : ""}`,
      "admin-small",
    ),
  );
  const controls = node("div", "", "admin-controls");
  for (const [status, label] of [
    ["published", "公开"],
    ["hidden", "隐藏"],
    ["pending", "转为待审核"],
  ]) {
    const b = node("button", label);
    b.disabled = c.status === status;
    b.addEventListener("click", () =>
      action(async () => {
        await api("comments/" + c.id, "PATCH", { status });
        await load();
      }),
    );
    controls.append(b);
  }
  el.append(controls);
  const reply = document.createElement("textarea");
  reply.maxLength = 1000;
  reply.placeholder = "项目组回复（可留空清除）";
  reply.setAttribute("aria-label", "回复 " + c.author);
  reply.value = c.reply;
  el.append(reply);
  const save = node("button", "保存回复");
  const wrap = node("div", "", "admin-controls");
  save.addEventListener("click", () =>
    action(async () => {
      await api("comments/" + c.id, "PATCH", { reply: reply.value });
      await load();
    }),
  );
  wrap.append(save);
  el.append(wrap);
  return el;
}
async function load(append = false) {
  const d = await api(
    "comments?status=" +
      $("#status").value +
      "&offset=" +
      (append ? offset : 0),
  );
  const target = $("#admin-comments");
  if (!append) {
    target.replaceChildren();
    offset = 0;
  }
  d.comments.forEach((c) => target.append(comment(c)));
  if (!d.comments.length && !append)
    target.append(node("p", "当前筛选下没有评论。", "muted"));
  offset += d.comments.length;
  $("#load-more").hidden = d.comments.length < 50;
  const counts = Object.fromEntries(d.counts.map((c) => [c.status, c.count]));
  $("#counts").textContent =
    `待审核 ${counts.pending || 0} · 已公开 ${counts.published || 0} · 已隐藏 ${counts.hidden || 0}`;
  $("#settings").elements.visible.checked = d.settings.commentsVisible;
  $("#settings").elements.posting.checked = d.settings.postingEnabled;
}
async function enter() {
  await api("me");
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
  await load();
}
$("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    button = form.querySelector("button");
  button.disabled = true;
  try {
    await api("login", "POST", Object.fromEntries(new FormData(form)));
    form.reset();
    $("#login-message").textContent = "";
    await enter();
  } catch (error) {
    $("#login-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#settings").addEventListener("submit", (e) => {
  e.preventDefault();
  void action(() =>
    api("settings", "PATCH", {
      commentsVisible: e.currentTarget.elements.visible.checked,
      postingEnabled: e.currentTarget.elements.posting.checked,
    }),
  );
});
$("#editorial").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget,
    values = Object.fromEntries(new FormData(form));
  void action(async () => {
    await api("comments", "POST", { ...values, role: "other" });
    form.elements.content.value = "";
    $("#status").value = "published";
    await load();
  });
});
$("#status").addEventListener("change", () => action(() => load()));
$("#refresh").addEventListener("click", () => action(() => load()));
$("#load-more").addEventListener("click", () => action(() => load(true)));
$("#logout").addEventListener("click", () =>
  action(async () => {
    await api("logout", "POST", {});
    $("#dashboard").hidden = true;
    $("#login").hidden = false;
    $("#admin-comments").replaceChildren();
  }),
);
enter().catch(() => {});
