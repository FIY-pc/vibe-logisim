import type {
  AssessmentCase,
  Lesson,
} from "../../../../packages/classroom/src/assessment-types";
export function templatePins(xml: string, circuit: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw Error("模板不支持DOCTYPE或外部实体");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (
    doc.querySelector("parsererror") ||
    doc.documentElement.tagName !== "project"
  )
    throw Error("请选择有效的circ文件");
  const main =
    circuit || doc.querySelector("main")?.getAttribute("name") || "main";
  const selected = [...doc.querySelectorAll("circuit")].find(
    (c) => c.getAttribute("name") === main,
  );
  if (!selected) throw Error("模板中找不到待评测电路");
  const pins = [...selected.children]
    .filter((c) => c.tagName === "comp" && c.getAttribute("name") === "Pin")
    .map((c) => {
      const attrs = Object.fromEntries(
        [...c.children]
          .filter((a) => a.tagName === "a")
          .map((a) => [
            a.getAttribute("name"),
            a.getAttribute("val") || a.textContent || "",
          ]),
      );
      return {
        name: attrs.label,
        output: attrs.output === "true",
        width: Number(attrs.width || 1),
      };
    });
  if (
    !pins.length ||
    pins.some((p) => !p.name) ||
    new Set(pins.map((p) => p.name)).size !== pins.length
  )
    throw Error("请为模板的输入、输出引脚设置唯一标签");
  return {
    circuit: main,
    inputs: pins.filter((p) => !p.output),
    outputs: pins.filter((p) => p.output),
  };
}
export const blankCase = (
  inputs: string[],
  outputs: string[],
  index: number,
): AssessmentCase => ({
  id: crypto.randomUUID(),
  title: `用例 ${index + 1}`,
  hidden: false,
  inputs: Object.fromEntries(inputs.map((k) => [k, 0])),
  expected: Object.fromEntries(outputs.map((k) => [k, 0])),
});
export const lessonKey = (server: string, user: string, room: string) =>
  `vibe.assessment:${server}:${user}:${room}`;
export const attemptStatus = (status: string) =>
  ({
    queued: "排队中",
    running: "评测中",
    passed: "通过",
    failed: "未通过",
    error: "评测异常",
  })[status] || status;
export function draftLesson(chapterId: string): Lesson {
  return {
    id: "",
    chapterId,
    title: "",
    description:
      "# 实验目标\n\n请完成电路设计，并提交评测。\n\n## 输入与输出\n\n",
    position: 0,
    published: false,
    points: 10,
    version: 0,
    gradingVersion: 1,
    circuit: "main",
    templateName: "",
    templateXml: "",
    images: [],
    tests: [blankCase(["A", "B"], ["Y"], 0)],
    testCount: 1,
    hiddenCount: 0,
  };
}
