import {
  buildScene,
  paintFrame,
  type Live,
  type Scene,
} from "../../../apps/workbench/src/editor/paint";
import type { Circuit } from "../../../apps/workbench/src/shared/types";
import type {
  Op,
  SymbolPicture,
} from "../../../apps/workbench/src/editor/symbols";
import { stories, timeline, clamp, type Story } from "./timeline";

interface Recording {
  schema: number;
  circuit: Circuit;
  symbols: SymbolPicture[];
  cases: {
    inputs: string;
    sum: string;
    cout: string;
    picture: {
      wires: Record<string, string>;
      dots: Record<string, string>;
      components: Record<string, Op[]>;
    };
  }[];
}
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const root = el("guided-demo");
const canvas = el<HTMLCanvasElement>("demo-canvas");
const progress = el<HTMLInputElement>("demo-progress");
const play = el<HTMLButtonElement>("demo-play");
const pinButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-demo-pin]"),
];
const promptButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-story]"),
];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let story: Story = "build",
  elapsed = 0,
  playing = false,
  started = false,
  previous = 0,
  raf = 0;
let data: Recording,
  scene: Scene,
  liveFrames: Live[],
  manualCase: number | null = null;
let lastDOM = "",
  lastPaint = "";
const text = (id: string, value: string) => {
  if (el(id).textContent !== value) el(id).textContent = value;
};
const seconds = (ms: number) =>
  `0:${Math.floor(ms / 1000)
    .toString()
    .padStart(2, "0")}`;
const ease = (n: number) => 1 - (1 - clamp(n)) ** 3;
const reveal = (text: string, fraction: number) =>
  text.slice(0, Math.ceil(text.length * fraction));
let tableRows: HTMLDivElement[] = [];

function paint(force = false) {
  const state = timeline(story, elapsed),
    box = canvas.getBoundingClientRect();
  const width = Math.round(box.width),
    height = Math.round(box.height);
  if (!width || !height) return;
  const index = manualCase ?? (started ? state.caseIndex : 0);
  const rawParts = started ? state.parts : 1,
    rawWires = started ? state.wires : 1;
  const parts = reducedMotion.matches ? Number(rawParts > 0) : rawParts;
  const wires = reducedMotion.matches ? Number(rawWires > 0) : rawWires;
  const key = `${width}:${height}:${devicePixelRatio}:${index}:${parts.toFixed(3)}:${wires.toFixed(3)}:${state.live}:${state.highlight}:${started}`;
  if (!force && key === lastPaint) return;
  lastPaint = key;
  // Match the editor's own drawing pipeline, not a second set of gate symbols.
  // Only the viewport and the recorded state change during this presentation.
  const scale = Math.min((width - 48) / 570, (height - 82) / 300, 1.65);
  const view = {
    x: 335 - width / scale / 2,
    y: 205 - (height - 34) / scale / 2,
    scale,
  };
  let drawing = scene;
  const ghosts = [];
  if (parts < 1 || wires < 1) {
    const count = parts * scene.parts.length;
    const shown = scene.parts.filter((_, i) => count >= i + 1);
    const appearing = scene.parts[Math.floor(count)];
    if (appearing && count > Math.floor(count))
      ghosts.push({
        program: appearing.program,
        x: appearing.x,
        y: appearing.y,
        alpha: ease(count % 1),
      });
    const length = scene.wires.reduce(
      (n, w) => n + Math.abs(w.to.x - w.from.x) + Math.abs(w.to.y - w.from.y),
      0,
    );
    let remaining = wires * length;
    const drawnWires = [];
    for (const w of scene.wires) {
      const len = Math.abs(w.to.x - w.from.x) + Math.abs(w.to.y - w.from.y);
      if (remaining <= 0) break;
      const f = Math.min(1, remaining / len);
      drawnWires.push({
        ...w,
        to: {
          x: w.from.x + (w.to.x - w.from.x) * f,
          y: w.from.y + (w.to.y - w.from.y) * f,
        },
      });
      remaining -= len;
    }
    drawing = {
      ...scene,
      parts: shown,
      wires: drawnWires,
      dots: wires === 1 ? scene.dots : [],
    };
  }
  paintFrame(
    canvas,
    {
      view,
      width,
      height,
      scene: drawing,
      hidden: new Set(),
      moved: null,
      added: [],
      ghosts,
      live:
        parts === 1 && wires === 1 && (!started || state.live)
          ? liveFrames[index]
          : null,
    },
    Math.min(devicePixelRatio || 1, 2),
  );
  text("demo-zoom", `${Math.round(scale * 100)}%`);
  const highlight = el("demo-highlight");
  highlight.hidden = !(started && state.highlight);
  if (!highlight.hidden) {
    highlight.style.left = `${(310 - view.x) * scale}px`;
    highlight.style.top = `${(232 - view.y) * scale}px`;
    highlight.style.width = `${210 * scale}px`;
    highlight.style.height = `${127 * scale}px`;
  }
}

function render() {
  const state = timeline(story, elapsed),
    script = stories[story];
  const index = manualCase ?? (started ? state.caseIndex : 0),
    values = data.cases[index];
  const signalsReady = !started || state.live;
  root.dataset.state = !started
    ? "idle"
    : state.complete
      ? "complete"
      : playing
        ? "playing"
        : "paused";
  progress.value = String(Math.round((elapsed / script.duration) * 1000));
  progress.style.setProperty(
    "--demo-played",
    `${(elapsed / script.duration) * 100}%`,
  );
  progress.setAttribute(
    "aria-valuetext",
    `${seconds(elapsed)}，${started ? state.stage : "尚未开始"}`,
  );
  text("demo-time", `${seconds(elapsed)} / ${seconds(script.duration)}`);
  play.setAttribute(
    "aria-label",
    playing ? "暂停演示" : state.complete ? "重新播放演示" : "播放演示",
  );
  play.firstElementChild!.textContent = playing ? "Ⅱ" : "▶";
  text("demo-stage", started ? state.stage : "选择上方提示词开始");
  text(
    "demo-canvas-status",
    !started
      ? "准备就绪"
      : state.complete
        ? "仿真就绪"
        : state.parts < 1
          ? "放置元件"
          : state.wires < 1
            ? "连接电路"
            : "仿真中",
  );
  for (const [i, button] of pinButtons.entries()) {
    button.disabled = started && !state.complete;
    button.setAttribute(
      "aria-pressed",
      String(signalsReady && values.inputs[i] === "1"),
    );
    button.setAttribute(
      "aria-label",
      signalsReady
        ? `切换输入 ${button.dataset.demoPin}，当前 ${values.inputs[i]}`
        : `输入 ${button.dataset.demoPin}，等待仿真`,
    );
    button.querySelector("b")!.textContent = signalsReady
      ? values.inputs[i]
      : "–";
  }
  text("demo-sum", signalsReady ? values.sum : "–");
  text("demo-cout", signalsReady ? values.cout : "–");
  el("demo-sum").dataset.on = values.sum;
  el("demo-cout").dataset.on = values.cout;
  const answerFraction = reducedMotion.matches
    ? Number(state.answer > 0)
    : state.answer;
  const userText = reveal(
    script.request,
    reducedMotion.matches ? 1 : state.draft,
  );
  const answerText = reveal(script.answer, answerFraction);
  const domKey = `${story}:${started}:${state.userVisible}:${userText}:${answerText}:${state.tested}:${state.task?.title}:${state.complete}`;
  if (domKey !== lastDOM) {
    lastDOM = domKey;
    el("demo-welcome").hidden = started;
    el("demo-messages").hidden = !started || !state.userVisible;
    el("demo-canvas-hint").hidden = started;
    text(
      "demo-draft",
      started && !state.userVisible ? userText || " " : "描述你的想法…",
    );
    el("demo-draft").classList.toggle(
      "is-typing",
      started && !state.userVisible,
    );
    text("demo-user-message", script.request);
    text("demo-answer", answerText || "正在梳理思路…");
    el("demo-answer").classList.toggle(
      "is-typing",
      answerFraction > 0 && answerFraction < 1,
    );
    el("demo-task").hidden = !state.task;
    if (state.task) {
      text("demo-task-title", state.task.title);
      text("demo-task-detail", state.task.detail);
      text("demo-task-icon", state.task.done ? "✓" : "⌁");
      el("demo-task").classList.toggle("is-done", state.task.done);
    }
    el("demo-truth-table").hidden = !(story === "verify" && elapsed >= 3000);
    for (const [i, row] of tableRows.entries()) {
      row.classList.toggle("is-tested", i < state.tested);
      row.classList.toggle(
        "is-current",
        i === state.tested && state.tested < 8,
      );
      row.lastElementChild!.textContent = i < state.tested ? "✓" : "·";
    }
    el("demo-result").hidden = !state.complete;
    text("demo-result-text", script.result);
    const chat = el("demo-chat-scroll");
    // Don't pull the page; only keep the conversation pane on its newest line.
    chat.scrollTop = chat.scrollHeight;
  }
  paint();
}

function frame(now: number) {
  if (!playing) return;
  elapsed = Math.min(
    stories[story].duration,
    elapsed + Math.max(0, now - previous),
  );
  previous = now;
  if (elapsed >= stories[story].duration) playing = false;
  render();
  if (playing) raf = requestAnimationFrame(frame);
}
function pause() {
  playing = false;
  cancelAnimationFrame(raf);
  render();
}
function resume() {
  playing = true;
  previous = performance.now();
  cancelAnimationFrame(raf);
  render();
  raf = requestAnimationFrame(frame);
}
function choose(next: Story) {
  story = next;
  elapsed = 0;
  started = true;
  manualCase = null;
  lastPaint = lastDOM = "";
  for (const button of promptButtons)
    button.setAttribute("aria-pressed", String(button.dataset.story === next));
  resume();
}

async function init() {
  const response = await fetch("assets/demo-recording.json");
  if (!response.ok) throw Error("Demo recording unavailable");
  data = (await response.json()) as Recording;
  if (data.schema !== 1 || data.cases.length !== 8)
    throw Error("Invalid demo recording");
  scene = buildScene(
    data.circuit,
    (c) => ({
      picture: data.symbols[data.circuit.components.indexOf(c)],
      error: "",
      definition: null,
    }),
    new Set(),
  );
  liveFrames = data.cases.map(({ picture }) => ({
    wires: new Map(
      Object.entries(picture.wires).map(([k, color]) => [
        k,
        [...k.split(",").map(Number), color] as [
          number,
          number,
          number,
          number,
          string,
        ],
      ]),
    ),
    dots: new Map(
      Object.entries(picture.dots).map(([k, color]) => [
        k,
        [...k.split(",").map(Number), color] as [number, number, string],
      ]),
    ),
    components: new Map(Object.entries(picture.components)),
  }));
  for (const c of data.cases) {
    const row = document.createElement("div");
    for (const value of [
      c.inputs.split("").join("  "),
      `${c.sum}      ${c.cout}`,
      "·",
    ]) {
      const span = document.createElement("span");
      span.textContent = value;
      row.append(span);
    }
    el("demo-table-rows").append(row);
    tableRows.push(row);
  }
  for (const button of promptButtons)
    button.addEventListener("click", () =>
      choose(button.dataset.story as Story),
    );
  play.addEventListener("click", () => {
    if (!started || elapsed === stories[story].duration) choose(story);
    else if (playing) pause();
    else resume();
  });
  el("demo-replay").addEventListener("click", () => choose(story));
  progress.addEventListener("input", () => {
    playing = false;
    cancelAnimationFrame(raf);
    started = true;
    manualCase = null;
    elapsed = (Number(progress.value) / 1000) * stories[story].duration;
    for (const button of promptButtons)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.story === story),
      );
    render();
  });
  for (const [i, button] of pinButtons.entries())
    button.addEventListener("click", () => {
      const bits =
        data.cases[
          manualCase ?? (started ? timeline(story, elapsed).caseIndex : 0)
        ].inputs.split("");
      bits[i] = bits[i] === "1" ? "0" : "1";
      manualCase = parseInt(bits.join(""), 2);
      render();
    });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && playing) pause();
  });
  new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting && playing) pause();
    },
    { threshold: 0 },
  ).observe(root);
  root.hidden = false;
  el("demo-fallback").hidden = true;
  render();
  new ResizeObserver(() => {
    paint(true);
    if (started && timeline(story, elapsed).complete) {
      const chat = el("demo-chat-scroll");
      chat.scrollTop = chat.scrollHeight;
    }
  }).observe(canvas);
  window.addEventListener("pagehide", () => cancelAnimationFrame(raf));
}
init().catch(() => {
  root.hidden = true;
  el("demo-fallback").hidden = false;
});
