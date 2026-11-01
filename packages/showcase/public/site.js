const $ = (s) => document.querySelector(s);
let release,
  offset = 0;
const comments = $("#comments");
async function request(route, body) {
  const r = await fetch("api/" + route, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "请求失败，请稍后重试");
  return d;
}
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2500);
}
async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast("已复制");
  } catch {
    toast("复制失败，请选中文本手动复制");
  }
}
$("#copy-address").addEventListener("click", () =>
  copy($("#classroom-address").textContent),
);
fetch("release.json")
  .then((r) => {
    if (!r.ok) throw Error();
    return r.json();
  })
  .then((data) => {
    release = data;
    for (const key of ["installer", "portable"]) {
      $(`[data-hash="${key}"]`).textContent =
        `${data[key].name}\n${data[key].sha256}`;
      $(`[data-kind="${key}"] span`).textContent =
        `${(data[key].bytes / 1048576).toFixed(1)} MiB ↗`;
    }
  })
  .catch(() => {
    document
      .querySelectorAll("[data-hash]")
      .forEach(
        (el) => (el.textContent = "暂时无法读取，请下载完整校验清单核对。"),
      );
  });
document
  .querySelectorAll("[data-copy]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      release
        ? copy(release[button.dataset.copy].sha256)
        : toast("校验信息尚未读取"),
    ),
  );
const views = {
  teacher: ["assets/teacher.png", "教师课堂管理界面，显示任务和学生学习状态"],
  student: ["assets/student.png", "学生课堂界面，显示自动同步状态"],
  review: ["assets/review.png", "教师只读审阅学生电路与AI交互记录"],
};

// Local full-adder illustration; switching an input never sends a request.
const adderInputs = { a: 0, b: 0, cin: 0 };
document.querySelectorAll("[data-input]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.dataset.input;
    adderInputs[input] ^= 1;
    button.setAttribute("aria-pressed", String(Boolean(adderInputs[input])));
    button.querySelector("b").textContent = String(adderInputs[input]);
    const total = adderInputs.a + adderInputs.b + adderInputs.cin;
    for (const [id, value] of [
      ["adder-sum", total % 2],
      ["adder-cout", total >= 2 ? 1 : 0],
    ]) {
      const output = document.getElementById(id);
      output.textContent = String(value);
      output.classList.toggle("on", Boolean(value));
    }
  });
});
document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((b) => {
      b.classList.toggle("active", b === button);
      b.setAttribute("aria-pressed", String(b === button));
    });
    const shot = $("#classroom-shot");
    [shot.src, shot.alt] = views[button.dataset.view];
  }),
);
function node(tag, content, className) {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
}
function renderComment(c) {
  const item = document.createElement("article");
  item.className = "comment";
  const heading = document.createElement("div");
  heading.className = "comment-heading";
  heading.append(
    node("strong", c.author),
    node(
      "span",
      c.source === "editorial"
        ? "站方发布"
        : { student: "学生", teacher: "教师", other: "体验者" }[c.role],
    ),
  );
  item.append(heading);
  if (c.rating) item.append(node("p", `${c.rating} / 5 分`, "comment-rating"));
  item.append(
    node("p", c.content, "comment-content"),
    node("time", new Date(c.createdAt).toLocaleDateString("zh-CN")),
  );
  if (c.reply) {
    const reply = document.createElement("div");
    reply.className = "comment-reply";
    reply.append(node("strong", "项目组回复"), node("p", c.reply));
    item.append(reply);
  }
  return item;
}
async function loadComments(append = false) {
  try {
    const d = await request("comments?offset=" + (append ? offset : 0));
    $("#feedback").hidden = !d.commentsVisible;
    $("#feedback-nav").hidden = !d.commentsVisible;
    if (!d.commentsVisible) return;
    $("#comment-count").textContent = d.total
      ? `${d.total} 条已公开反馈`
      : "等你留下第一条反馈";
    $("#comment-form").hidden = !d.postingEnabled;
    if (!append) {
      comments.replaceChildren();
      offset = 0;
    }
    if (!d.total)
      comments.append(
        node("p", "用过之后，来聊聊你的发现吧。", "empty-comments"),
      );
    d.comments.forEach((c) => comments.append(renderComment(c)));
    offset += d.comments.length;
    $("#more-comments").hidden = offset >= d.total;
  } catch {
    if (!append)
      comments.replaceChildren(
        node("p", "暂时无法读取反馈，请稍后刷新。", "muted"),
      );
    $("#comment-count").textContent = "";
  }
}
$("#more-comments").addEventListener("click", () => loadComments(true));
$("#comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('[type="submit"]'),
    message = $("#form-message");
  button.disabled = true;
  message.textContent = "正在提交…";
  const f = Object.fromEntries(new FormData(form));
  try {
    const d = await request("comments", {
      ...f,
      rating: f.rating ? Number(f.rating) : null,
      consent: form.elements.consent.checked,
    });
    message.textContent = d.message;
    message.className = "success";
    form.reset();
  } catch (e) {
    message.textContent = e.message;
    message.className = "error";
  } finally {
    button.disabled = false;
  }
});
loadComments();
