/** Deterministic playback. Seeking/restarting cannot leave old timers or text behind. */
export const stories = {
  build: {
    prompt: "构建一个全加器",
    request:
      "帮我构建一个一位全加器，包含 A、B、Cin 输入，以及 Sum 和 Cout 输出。",
    answer:
      "我会使用两个异或门计算和位，用两个与门和一个或门生成进位。接下来放置元件、完成连线，并验证所有输入组合。",
    result:
      "全加器已完成，8 组输入全部通过。试着切换画布下方的输入，观察输出。",
    duration: 12000,
  },
  explain: {
    prompt: "为什么会产生进位？",
    request:
      "A=1、B=1、Cin=0 时，为什么 Sum=0，而 Cout=1？帮我解释电路里的进位路径。",
    answer:
      "1 + 1 + 0 = 二进制 10，因此 Sum=0、Cout=1。\n\n电路中，A AND B 这条支路输出 1，经过或门得到进位。\n\nCout = (A AND B) OR (Cin AND (A XOR B))。",
    result: "高亮区域就是进位逻辑。你也可以切换输入，对照这条公式继续探索。",
    duration: 10000,
  },
  verify: {
    prompt: "验证全部输入组合",
    request: "验证这个全加器的全部 8 组输入，检查 Sum 和 Cout 是否符合真值表。",
    answer:
      "我会依次设置 A、B、Cin，从 000 到 111，读取 Sum 与 Cout，并与二进制加法结果逐组核对。",
    result: "8 / 8 组验证通过。Sum 是和的最低位，Cout 是向高位的进位。",
    duration: 10000,
  },
} as const;
export type Story = keyof typeof stories;
export const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function timeline(story: Story, time: number) {
  const t = Math.max(0, Math.min(stories[story].duration, time));
  const complete = t === stories[story].duration;
  const build = story === "build",
    explain = story === "explain";
  const testStart = build ? 7400 : 3100,
    testStep = build ? 300 : 600;
  const tested = explain
    ? 0
    : Math.max(0, Math.min(8, Math.floor((t - testStart) / testStep)));
  const caseIndex =
    explain || complete || (build ? t >= 10500 : t >= 8500)
      ? 6
      : Math.max(0, Math.min(7, Math.floor((t - testStart) / testStep)));
  const stage = complete
    ? "演示完成，试试切换输入"
    : t < 900
      ? "输入需求"
      : build && t < 2800
        ? "梳理电路结构"
        : build && t < 4300
          ? "放置输入与逻辑门"
          : build && t < 7200
            ? "连接 Sum 与 Cout"
            : explain
              ? "沿着进位路径理解电路"
              : t < testStart
                ? "准备仿真"
                : tested < 8
                  ? `验证输入组合 · ${tested} / 8`
                  : "8 组输入全部通过";
  return {
    time: t,
    complete,
    stage,
    caseIndex,
    tested,
    userVisible: t >= 900,
    draft: clamp(t / 800),
    answer: clamp((t - 1100) / (explain ? 4600 : 2000)),
    parts: build ? clamp((t - 2800) / 1400) : 1,
    wires: build ? clamp((t - 4300) / 2800) : 1,
    live: !build || t >= 7300,
    highlight: explain && t >= 3300,
    task:
      t < (build ? 2800 : explain ? 3300 : 3000)
        ? null
        : {
            title: complete
              ? explain
                ? "进位路径已定位"
                : "真值表验证完成"
              : stage,
            detail:
              build && t < 4300
                ? "3 个输入 · 5 个逻辑门 · 2 个输出"
                : build && t < 7200
                  ? "连接和位与进位支路"
                  : explain
                    ? "A=1 · B=1 · Cin=0 → Sum=0 · Cout=1"
                    : `${tested} / 8 组输入符合预期`,
            done: complete || (!explain && tested === 8),
          },
  };
}
