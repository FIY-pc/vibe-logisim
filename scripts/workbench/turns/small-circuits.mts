/**
 * Scripted turn: in an empty folder, build one small gate-level circuit the
 * question names, check it with vectors where it is combinational, arrange it,
 * check again and look at the drawing. The parts are placed roughly where a
 * person sketching it would put them and wired with connect, so the drawing
 * before arranging is what the connect router makes of that sketch.
 *
 *   node scripts/workbench/scripted-model.mts --port 8903 --script scripts/workbench/turns/small-circuits.mts
 *
 * Circuits by question: "2 选 1"、"4 选 1"、"译码器"、"四位加法器"、"计数器"、
 * "累加器"、"内置选择器"、"取反". "不整理" stops after the first check.
 */
import type { Script, Step } from "../scripted-model.mts";

type Part = {
  factory: string;
  location: { x: number; y: number };
  attributes?: Record<string, string>;
};
type Link = [string, number, string, number];
interface Build {
  file: string;
  parts: Part[];
  links: Link[];
  vectors?: {
    inputs: Record<string, number>;
    expected: Record<string, number>;
  }[];
}

const id = (x: number, y: number) => `c${x}_${y}`;
const pin = (
  x: number,
  y: number,
  label: string,
  extra: Record<string, string> = {},
): Part => ({
  factory: "Pin",
  location: { x, y },
  attributes: { label, ...extra },
});
const out = (
  x: number,
  y: number,
  label: string,
  extra: Record<string, string> = {},
) => pin(x, y, label, { output: "true", facing: "west", ...extra });
const part = (
  factory: string,
  x: number,
  y: number,
  attributes?: Record<string, string>,
): Part => ({
  factory,
  location: { x, y },
  ...(attributes ? { attributes } : {}),
});
const bits = (n: number, count: number) =>
  [...Array(count)].map((_, i) => (n >> i) & 1);

function mux2(): Build {
  return {
    file: "mux2.circ",
    parts: [
      pin(100, 100, "A"),
      pin(100, 200, "B"),
      pin(100, 300, "S"),
      part("NOT Gate", 200, 300),
      part("AND Gate", 320, 120),
      part("AND Gate", 320, 220),
      part("OR Gate", 440, 170),
      out(540, 170, "Y"),
    ],
    links: [
      [id(100, 100), 0, id(320, 120), 1],
      [id(100, 300), 0, id(200, 300), 1],
      [id(200, 300), 0, id(320, 120), 2],
      [id(100, 200), 0, id(320, 220), 1],
      [id(100, 300), 0, id(320, 220), 2],
      [id(320, 120), 0, id(440, 170), 1],
      [id(320, 220), 0, id(440, 170), 2],
      [id(440, 170), 0, id(540, 170), 0],
    ],
    vectors: [...Array(8)].map((_, n) => {
      const [a, b, s] = bits(n, 3);
      return { inputs: { A: a, B: b, S: s }, expected: { Y: s ? b : a } };
    }),
  };
}

function mux4(): Build {
  const and3 = { inputs: "3" };
  const ands = [120, 200, 280, 360];
  return {
    file: "mux4.circ",
    parts: [
      ...[0, 1, 2, 3].map((i) => pin(100, 100 + 70 * i, `D${i}`)),
      pin(100, 440, "S1"),
      pin(100, 500, "S0"),
      part("NOT Gate", 200, 440),
      part("NOT Gate", 200, 500),
      ...ands.map((y) => part("AND Gate", 400, y, and3)),
      part("OR Gate", 520, 240, { inputs: "4" }),
      out(620, 240, "Y"),
    ],
    links: [
      [id(100, 440), 0, id(200, 440), 1],
      [id(100, 500), 0, id(200, 500), 1],
      ...ands.flatMap((y, i): Link[] => [
        [i & 2 ? id(100, 440) : id(200, 440), 0, id(400, y), 2],
        [i & 1 ? id(100, 500) : id(200, 500), 0, id(400, y), 3],
      ]),
      ...ands.flatMap((y, i): Link[] => [
        [id(100, 100 + 70 * i), 0, id(400, y), 1],
        [id(400, y), 0, id(520, 240), i + 1],
      ]),
      [id(520, 240), 0, id(620, 240), 0],
    ],
    vectors: [...Array(64)].map((_, n) => {
      const [d0, d1, d2, d3, s0, s1] = bits(n, 6);
      const d = [d0, d1, d2, d3];
      return {
        inputs: { D0: d0, D1: d1, D2: d2, D3: d3, S0: s0, S1: s1 },
        expected: { Y: d[s1 * 2 + s0] },
      };
    }),
  };
}

function decoder(): Build {
  const ands = [120, 200, 280, 360];
  return {
    file: "decoder.circ",
    parts: [
      pin(100, 100, "EN"),
      pin(100, 180, "A1"),
      pin(100, 260, "A0"),
      part("NOT Gate", 200, 180),
      part("NOT Gate", 200, 260),
      ...ands.map((y) => part("AND Gate", 360, y, { inputs: "3" })),
      ...ands.map((y, i) => out(480, y, `Y${i}`)),
    ],
    links: ands
      .flatMap((y, i): Link[] => [
        [id(100, 100), 0, id(360, y), 1],
        [i & 2 ? id(100, 180) : id(200, 180), 0, id(360, y), 2],
        [i & 1 ? id(100, 260) : id(200, 260), 0, id(360, y), 3],
        [id(360, y), 0, id(480, y), 0],
      ])
      .concat([
        [id(100, 180), 0, id(200, 180), 1],
        [id(100, 260), 0, id(200, 260), 1],
      ]),
    vectors: [...Array(8)].map((_, n) => {
      const [a0, a1, en] = bits(n, 3);
      const k = a1 * 2 + a0;
      const expected: Record<string, number> = {};
      for (let i = 0; i < 4; i++) expected[`Y${i}`] = en && i === k ? 1 : 0;
      return { inputs: { EN: en, A1: a1, A0: a0 }, expected };
    }),
  };
}

function adder4(): Build {
  const parts: Part[] = [pin(100, 30, "Cin")];
  const links: Link[] = [];
  let carry: [string, number] = [id(100, 30), 0];
  for (let i = 0; i < 4; i++) {
    const y = 80 + 180 * i;
    parts.push(
      pin(100, y, `A${i}`),
      pin(100, y + 40, `B${i}`),
      part("XOR Gate", 260, y + 30),
      part("XOR Gate", 420, y + 40),
      part("AND Gate", 420, y + 100),
      part("AND Gate", 420, y + 150),
      part("OR Gate", 540, y + 130),
      out(640, y + 40, `S${i}`),
    );
    const [a, b, x1, x2, n1, n2, o] = [
      id(100, y),
      id(100, y + 40),
      id(260, y + 30),
      id(420, y + 40),
      id(420, y + 100),
      id(420, y + 150),
      id(540, y + 130),
    ];
    links.push(
      [a, 0, x1, 1],
      [b, 0, x1, 2],
      [x1, 0, x2, 1],
      [carry[0], carry[1], x2, 2],
      [x1, 0, n1, 1],
      [carry[0], carry[1], n1, 2],
      [a, 0, n2, 1],
      [b, 0, n2, 2],
      [n1, 0, o, 1],
      [n2, 0, o, 2],
      [x2, 0, id(640, y + 40), 0],
    );
    carry = [o, 0];
  }
  parts.push(out(640, 80 + 180 * 3 + 130, "Cout"));
  links.push([carry[0], carry[1], id(640, 80 + 180 * 3 + 130), 0]);
  const vectors = [...Array(64)].map((_, n) => {
    const a = (n * 7) & 15,
      b = (n * 11 + 3) & 15,
      cin = n & 1;
    const sum = a + b + cin;
    const inputs: Record<string, number> = { Cin: cin };
    const expected: Record<string, number> = { Cout: sum >> 4 };
    bits(a, 4).forEach((v, i) => (inputs[`A${i}`] = v));
    bits(b, 4).forEach((v, i) => (inputs[`B${i}`] = v));
    bits(sum, 4).forEach((v, i) => (expected[`S${i}`] = v));
    return { inputs, expected };
  });
  return { file: "adder4.circ", parts, links, vectors };
}

function counter(): Build {
  // three D flip-flops counting while EN is high: D_i = Q_i xor (EN and Q_0 .. Q_{i-1})
  const ffs = [120, 260, 400];
  return {
    file: "counter.circ",
    parts: [
      pin(100, 100, "EN"),
      part("Clock", 100, 460),
      part("XOR Gate", 300, 130),
      part("AND Gate", 300, 210),
      part("XOR Gate", 300, 270),
      part("AND Gate", 300, 350),
      part("XOR Gate", 300, 410),
      ...ffs.map((y) => part("D Flip-Flop", 440, y)),
      ...ffs.map((y, i) => out(560, y, `Q${i}`)),
    ],
    links: [
      [id(100, 100), 0, id(300, 130), 1],
      [id(440, 120), 1, id(300, 130), 2],
      [id(100, 100), 0, id(300, 210), 1],
      [id(440, 120), 1, id(300, 210), 2],
      [id(300, 210), 0, id(300, 270), 1],
      [id(440, 260), 1, id(300, 270), 2],
      [id(300, 210), 0, id(300, 350), 1],
      [id(440, 260), 1, id(300, 350), 2],
      [id(300, 350), 0, id(300, 410), 1],
      [id(440, 400), 1, id(300, 410), 2],
      [id(300, 130), 0, id(440, 120), 0],
      [id(300, 270), 0, id(440, 260), 0],
      [id(300, 410), 0, id(440, 400), 0],
      ...ffs.map((y): Link => [id(100, 460), 0, id(440, y), 5]),
      ...ffs.map((y): Link => [id(440, y), 1, id(560, y), 0]),
    ],
  };
}

function accumulator(): Build {
  return {
    file: "accumulator.circ",
    parts: [
      pin(120, 100, "D", { width: "8" }),
      part("Clock", 120, 200),
      part("Adder", 280, 110, { width: "8" }),
      part("Register", 400, 110, { width: "8" }),
      out(520, 110, "Q", { width: "8" }),
    ],
    links: [
      [id(400, 110), 0, id(280, 110), 0],
      [id(120, 100), 0, id(280, 110), 1],
      [id(280, 110), 2, id(400, 110), 1],
      [id(120, 200), 0, id(400, 110), 2],
      [id(400, 110), 0, id(520, 110), 0],
    ],
  };
}

function builtinMux(): Build {
  return {
    file: "builtin-mux.circ",
    parts: [
      ...[0, 1, 2, 3].map((i) => pin(100, 100 + 40 * i, `D${i}`)),
      pin(100, 300, "S", { width: "2" }),
      part("Multiplexer", 300, 180, { select: "2" }),
      out(400, 180, "Y"),
    ],
    links: [
      ...[0, 1, 2, 3].map((i): Link => [
        id(100, 100 + 40 * i),
        0,
        id(300, 180),
        i,
      ]),
      [id(100, 300), 0, id(300, 180), 4],
      [id(300, 180), 5, id(400, 180), 0],
    ],
    vectors: [...Array(64)].map((_, n) => {
      const d = bits(n, 4),
        s = n >> 4;
      return {
        inputs: { D0: d[0], D1: d[1], D2: d[2], D3: d[3], S: s },
        expected: { Y: d[s] },
      };
    }),
  };
}

function inverter(): Build {
  const nots = [120, 170, 220, 270];
  return {
    file: "invert4.circ",
    parts: [
      pin(100, 200, "X", { width: "4" }),
      part("Splitter", 180, 200, { fanout: "4", incoming: "4" }),
      ...nots.map((y) => part("NOT Gate", 300, y)),
      part("Splitter", 420, 160, {
        facing: "west",
        fanout: "4",
        incoming: "4",
      }),
      out(520, 160, "Y", { width: "4" }),
    ],
    links: [
      [id(100, 200), 0, id(180, 200), 0],
      ...nots.flatMap((y, i): Link[] => [
        [id(180, 200), i + 1, id(300, y), 1],
        [id(300, y), 0, id(420, 160), i + 1],
      ]),
      [id(420, 160), 0, id(520, 160), 0],
    ],
    vectors: [...Array(16)].map((_, x) => ({
      inputs: { X: x },
      expected: { Y: x ^ 15 },
    })),
  };
}

const builds: [string, () => Build][] = [
  ["2 选 1", mux2],
  ["4 选 1", mux4],
  ["译码器", decoder],
  ["四位加法器", adder4],
  ["计数器", counter],
  ["累加器", accumulator],
  ["内置选择器", builtinMux],
  ["取反", inverter],
];

function steps(build: Build): Step[] {
  const check: Step[] = build.vectors
    ? [
        {
          text: "用真值表检查。",
          tool: { name: "simulate_circuit", args: { vectors: build.vectors } },
        },
      ]
    : [];
  return [
    {
      text: "新建电路。",
      tool: { name: "create_circuit", args: { path: build.file } },
    },
    {
      text: "放置元件。",
      tool: { name: "place_component", args: { components: build.parts } },
    },
    {
      text: "连线。",
      tool: {
        name: "connect",
        args: {
          connections: build.links.map(([a, i, b, j]) => ({
            from: { component: a, port: i },
            to: { component: b, port: j },
          })),
        },
      },
    },
    ...check,
    { text: "整理布局。", tool: { name: "arrange_circuit", args: {} } },
    ...check.map((s) => ({ ...s, text: "整理后再检查一次。" })),
    { text: "看一下图面。", tool: { name: "render_circuit", args: {} } },
  ];
}

const script: Script = ({ question, calls }) => {
  const build = builds.find(([word]) => question.includes(word))?.[1]();
  if (!build) return { text: `不认识的电路：${question}` };
  const plan = steps(build);
  const last = calls.at(-1);
  if (last?.error)
    return {
      text: `${last.name} 失败：${last.error.code} ${last.error.message}`,
    };
  if (last?.name === "simulate_circuit" && last.result.failed)
    return { text: `真值表有 ${last.result.failed} 行不对。` };
  const arrangeAt = plan.findIndex((s) => s.tool?.name === "arrange_circuit");
  if (question.includes("不整理") && calls.length === arrangeAt)
    return { text: `${build.file} 已连好。` };
  return plan[calls.length] ?? { text: `${build.file} 已完成，布局已整理。` };
};
export default script;
