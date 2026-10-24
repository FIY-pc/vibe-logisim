/**
 * Scripted turn: in an empty folder, build a one-bit full adder from gates,
 * check it with vectors, arrange it, check again and look at the drawing.
 * Every step is one real tool call; a failed call ends the turn with the
 * error as the answer so the run shows where it broke.
 */
import type { Script, Step } from "../scripted-model.mts";

const pin = (x: number, y: number, label: string, output = false) => ({
  factory: "Pin",
  location: { x, y },
  attributes: output ? { label, output: "true", facing: "west" } : { label },
});
const gate = (factory: string, x: number, y: number) => ({
  factory,
  location: { x, y },
});
const port = (component: string, port: number) => ({ component, port });
const vectors = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => {
  const [a, b, cin] = [(n >> 2) & 1, (n >> 1) & 1, n & 1];
  const sum = a + b + cin;
  return { inputs: { A: a, B: b, Cin: cin }, expected: { S: sum & 1, Cout: sum >> 1 } };
});

const steps: Step[] = [
  { text: "新建一个全加器电路。", tool: { name: "create_circuit", args: { path: "full-adder.circ" } } },
  {
    text: "放置输入、门和输出。",
    tool: {
      name: "place_component",
      args: {
        components: [
          pin(100, 100, "A"),
          pin(100, 160, "B"),
          pin(100, 220, "Cin"),
          gate("XOR Gate", 240, 130),
          gate("XOR Gate", 400, 190),
          gate("AND Gate", 400, 260),
          gate("AND Gate", 400, 330),
          gate("OR Gate", 500, 290),
          pin(600, 190, "S", true),
          pin(600, 290, "Cout", true),
        ],
      },
    },
  },
  {
    text: "连线。",
    tool: {
      name: "connect",
      args: {
        connections: [
          { from: port("c100_100", 0), to: port("c240_130", 1) },
          { from: port("c100_160", 0), to: port("c240_130", 2) },
          { from: port("c240_130", 0), to: port("c400_190", 1) },
          { from: port("c100_220", 0), to: port("c400_190", 2) },
          { from: port("c240_130", 0), to: port("c400_260", 1) },
          { from: port("c100_220", 0), to: port("c400_260", 2) },
          { from: port("c100_100", 0), to: port("c400_330", 1) },
          { from: port("c100_160", 0), to: port("c400_330", 2) },
          { from: port("c400_260", 0), to: port("c500_290", 1) },
          { from: port("c400_330", 0), to: port("c500_290", 2) },
          { from: port("c400_190", 0), to: port("c600_190", 0) },
          { from: port("c500_290", 0), to: port("c600_290", 0) },
        ],
      },
    },
  },
  { text: "用真值表检查。", tool: { name: "simulate_circuit", args: { vectors } } },
  { text: "整理布局。", tool: { name: "arrange_circuit", args: {} } },
  { text: "整理后再检查一次。", tool: { name: "simulate_circuit", args: { vectors } } },
  { text: "看一下图面。", tool: { name: "render_circuit", args: {} } },
];

const script: Script = ({ question, calls }) => {
  const last = calls.at(-1);
  // "不整理" stops after the first check, leaving the routed wiring as drawn.
  if (question.includes("不整理") && calls.length === 4)
    return { text: "全加器已连好：8 行真值表全部通过。" };
  if (last?.error)
    return { text: `${last.name} 失败：${last.error.code} ${last.error.message}` };
  if (last?.name === "simulate_circuit" && last.result.failed)
    return { text: `真值表有 ${last.result.failed} 行不对。` };
  return steps[calls.length] ?? { text: "全加器已完成：8 行真值表全部通过，布局已整理。" };
};
export default script;
