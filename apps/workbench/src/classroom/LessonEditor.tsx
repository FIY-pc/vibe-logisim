import { Button, TextArea, TextField, Heading } from "../design/ui";
import { Table, Tabs } from "@radix-ui/themes";
import { Checkbox } from "../shared/Checkbox";
import { Select } from "../shared/Select";
import { useState } from "react";
import type {
  Lesson,
  AssessmentCase,
  Chapter,
} from "../../../../packages/classroom/src/assessment-types";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { blankCase, templatePins } from "./assessment-utils";

export function LessonMarkdown({
  lesson,
}: {
  lesson: Pick<Lesson, "description" | "images">;
}) {
  return (
    <div className="lesson-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) =>
          url.startsWith("image:") ? url : defaultUrlTransform(url)
        }
        components={{
          img: ({ src, alt }) => {
            const image = lesson.images.find((i) => "image:" + i.id === src);
            return image ? (
              <img src={image.data} alt={alt || image.name} />
            ) : (
              <span>图片未附加</span>
            );
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {lesson.description}
      </Markdown>
    </div>
  );
}
export function LessonEditor({
  initial,
  chapters,
  onSave,
  onCancel,
}: {
  initial: Lesson;
  chapters: Chapter[];
  onSave: (lesson: Lesson) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Lesson>(initial),
    [tab, setTab] = useState<"description" | "cases">("description"),
    [preview, setPreview] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [count, setCount] = useState(String(initial.tests.length));
  const [inputNames, setInputNames] = useState(
      Object.keys(initial.tests[0].inputs).join(", "),
    ),
    [outputNames, setOutputNames] = useState(
      Object.keys(initial.tests[0].expected).join(", "),
    );
  const patch = (change: Partial<Lesson>) =>
    setDraft((d) => ({ ...d, ...change }));
  const run = async (work: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const inputs = Object.keys(draft.tests[0].inputs),
    outputs = Object.keys(draft.tests[0].expected);
  const applyPorts = () => {
    const names = (s: string) => {
      const list = s
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        !list.length ||
        new Set(list).size !== list.length ||
        list.some(
          (n) =>
            n.length > 80 ||
            ["__proto__", "constructor", "prototype"].includes(n),
        )
      )
        throw Error("引脚名不能为空、重复或使用保留名称");
      return list;
    };
    const ins = names(inputNames),
      outs = names(outputNames);
    patch({
      tests: draft.tests.map((t) => ({
        ...t,
        inputs: Object.fromEntries(ins.map((k) => [k, t.inputs[k] ?? 0])),
        expected: Object.fromEntries(outs.map((k) => [k, t.expected[k] ?? 0])),
      })),
    });
  };
  const updateCase = (i: number, change: Partial<AssessmentCase>) =>
    patch({
      tests: draft.tests.map((t, n) => (i === n ? { ...t, ...change } : t)),
    });
  const uploadTemplate = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) throw Error("模板不能超过4MB");
    const xml = await file.text(),
      main =
        new DOMParser()
          .parseFromString(xml, "application/xml")
          .querySelector("main")
          ?.getAttribute("name") || "main",
      pins = templatePins(xml, main);
    if (!pins.inputs.length || !pins.outputs.length)
      throw Error("模板需要同时包含输入和输出引脚");
    const ins = pins.inputs.map((p) => p.name),
      outs = pins.outputs.map((p) => p.name);
    setInputNames(ins.join(", "));
    setOutputNames(outs.join(", "));
    patch({
      templateXml: xml,
      templateName: file.name,
      circuit: pins.circuit,
      tests: draft.tests.map((t, i) => ({
        ...t,
        inputs: Object.fromEntries(ins.map((k) => [k, t.inputs[k] ?? 0])),
        expected: Object.fromEntries(outs.map((k) => [k, t.expected[k] ?? 0])),
        title: t.title,
        hidden: t.hidden,
      })),
    });
  };
  const addImages = async (files: FileList | null) => {
    if (!files) return;
    if (files.length + draft.images.length > 6)
      throw Error("每个关卡最多6张图片");
    const added = [];
    for (const f of Array.from(files)) {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(f.type) ||
        f.size > 2 * 1024 * 1024
      )
        throw Error("请选择2MB以内的PNG、JPEG或WebP图片");
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(Error("图片读取失败"));
        r.readAsDataURL(f);
      });
      added.push({ id: crypto.randomUUID(), name: f.name, data });
    }
    patch({
      images: [...draft.images, ...added],
      description:
        draft.description +
        "\n\n" +
        added
          .map((a) => `![${a.name.replace(/[\[\]]/g, "")}](image:${a.id})`)
          .join("\n\n"),
    });
  };
  return (
    <form
      className="lesson-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (!draft.templateXml) throw Error("请上传初始电路模板");
          await onSave(draft);
        });
      }}
    >
      <div className="assessment-heading">
        <Heading as="h3">{initial.id ? "编辑关卡" : "新增关卡"}</Heading>
        <div>
          <Button
            variant="soft"
            color="gray"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            取消编辑
          </Button>
          <Button variant="solid" disabled={busy} type="submit">
            {busy ? "保存中…" : "保存关卡"}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="classroom-error">
          {error}
        </p>
      )}
      <div className="lesson-form-row">
        <label>
          关卡名称
          <TextField.Root
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            required
            maxLength={120}
          />
        </label>
        <label>
          所属章节
          <Select
            label="所属章节"
            value={draft.chapterId}
            onChange={(chapterId) => patch({ chapterId })}
            options={chapters.map((c) => ({ value: c.id, label: c.title }))}
          />
        </label>
        <label>
          排序
          <TextField.Root
            type="number"
            min={0}
            max={10000}
            value={draft.position}
            onChange={(e) => patch({ position: Number(e.target.value) })}
          />
        </label>
        <label>
          分值（全部用例通过才得分）
          <TextField.Root
            type="number"
            min={0}
            max={1000}
            value={draft.points}
            onChange={(e) => patch({ points: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="classroom-check">
        <Checkbox
          checked={draft.published}
          onCheckedChange={(published) => patch({ published })}
        />
        发布后学生可见
      </label>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(value as "description" | "cases")}
      >
        <Tabs.List aria-label="编辑关卡" mb="4">
          <Tabs.Trigger value="description">关卡说明</Tabs.Trigger>
          <Tabs.Trigger value="cases">
            模板与测试用例（{draft.tests.length}）
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="description">
          <div className="lesson-upload-tools">
            <label className="assessment-upload">
              导入 Markdown
              <input
                type="file"
                accept=".md,.markdown,.txt"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void run(async () => {
                      if (f.size > 100000) throw Error("描述最多100KB");
                      patch({ description: await f.text() });
                    });
                }}
              />
            </label>
            <label className="assessment-upload">
              上传插图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={busy}
                onChange={(e) => void run(() => addImages(e.target.files))}
              />
            </label>
            <Button
              variant="soft"
              color="gray"
              type="button"
              onClick={() => setPreview(!preview)}
            >
              {preview ? "继续编辑" : "预览说明"}
            </Button>
          </div>
          {preview ? (
            <LessonMarkdown lesson={draft} />
          ) : (
            <label>
              Markdown 内容
              <TextArea
                rows={13}
                value={draft.description}
                maxLength={100000}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </label>
          )}
          {draft.images.length > 0 && (
            <div className="lesson-image-list">
              {draft.images.map((image) => (
                <div key={image.id}>
                  <img src={image.data} alt={image.name} />
                  <span>{image.name}</span>
                  <Button
                    variant="soft"
                    color="gray"
                    type="button"
                    onClick={() =>
                      patch({
                        images: draft.images.filter((i) => i.id !== image.id),
                      })
                    }
                  >
                    移除图片
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Tabs.Content>
        <Tabs.Content value="cases">
          <div className="lesson-template">
            <label>
              初始电路模板（.circ）
              <input
                type="file"
                accept=".circ"
                onChange={(e) =>
                  void run(() => uploadTemplate(e.target.files?.[0]))
                }
                disabled={busy}
              />
            </label>
            <p>{draft.templateName || "尚未上传模板"}</p>
            <label>
              待评测电路名称
              <TextField.Root
                value={draft.circuit}
                onChange={(e) => patch({ circuit: e.target.value })}
                required
                maxLength={80}
              />
            </label>
          </div>
          <p className="assessment-help">
            用引脚标签匹配输入、输出，支持内置组合逻辑与项目内子电路。上传模板会按模板引脚重新设置用例列。
          </p>
          <div className="lesson-ports">
            <label>
              输入标签（逗号分隔）
              <TextField.Root
                value={inputNames}
                onChange={(e) => setInputNames(e.target.value)}
              />
            </label>
            <label>
              输出标签（逗号分隔）
              <TextField.Root
                value={outputNames}
                onChange={(e) => setOutputNames(e.target.value)}
              />
            </label>
            <Button
              variant="soft"
              color="gray"
              type="button"
              onClick={() => void run(async () => applyPorts())}
            >
              应用引脚设置
            </Button>
          </div>
          <div className="lesson-case-tools">
            <label>
              用例数量
              <TextField.Root
                type="number"
                min={1}
                max={256}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>
            <Button
              variant="soft"
              color="gray"
              type="button"
              onClick={() =>
                void run(async () => {
                  const n = Number(count);
                  if (!Number.isInteger(n) || n < 1 || n > 256)
                    throw Error("用例数量为1–256");
                  patch({
                    tests: Array.from(
                      { length: n },
                      (_, i) => draft.tests[i] || blankCase(inputs, outputs, i),
                    ),
                  });
                })
              }
            >
              应用数量
            </Button>
            <span>隐藏用例仅向学生反馈通过情况</span>
          </div>
          <div className="lesson-table-scroll">
            <Table.Root className="assessment-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>用例</Table.ColumnHeaderCell>
                  {inputs.map((k) => (
                    <Table.ColumnHeaderCell key={"in" + k}>
                      输入 {k}
                    </Table.ColumnHeaderCell>
                  ))}
                  {outputs.map((k) => (
                    <Table.ColumnHeaderCell key={"out" + k}>
                      预期 {k}
                    </Table.ColumnHeaderCell>
                  ))}
                  <Table.ColumnHeaderCell>隐藏</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {draft.tests.map((t, i) => (
                  <Table.Row key={t.id}>
                    <Table.Cell>
                      <TextField.Root
                        aria-label={`用例${i + 1}名称`}
                        value={t.title}
                        onChange={(e) =>
                          updateCase(i, { title: e.target.value })
                        }
                        maxLength={100}
                      />
                    </Table.Cell>
                    {inputs.map((k) => (
                      <Table.Cell key={"i" + k}>
                        <TextField.Root
                          aria-label={`用例${i + 1}输入${k}`}
                          type="number"
                          required
                          min={0}
                          max={4294967295}
                          value={t.inputs[k]}
                          onChange={(e) =>
                            updateCase(i, {
                              inputs: {
                                ...t.inputs,
                                [k]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </Table.Cell>
                    ))}
                    {outputs.map((k) => (
                      <Table.Cell key={"o" + k}>
                        <TextField.Root
                          aria-label={`用例${i + 1}预期${k}`}
                          type="number"
                          required
                          min={0}
                          max={4294967295}
                          value={t.expected[k]}
                          onChange={(e) =>
                            updateCase(i, {
                              expected: {
                                ...t.expected,
                                [k]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </Table.Cell>
                    ))}
                    <Table.Cell>
                      <Checkbox
                        label={`隐藏用例${i + 1}`}
                        checked={t.hidden}
                        onCheckedChange={(hidden) => updateCase(i, { hidden })}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </div>
          <details className="lesson-case-json">
            <summary>批量导入用例 JSON</summary>
            <TextArea
              aria-label="批量用例JSON"
              id="assessment-case-json"
              rows={6}
              defaultValue={JSON.stringify(draft.tests, null, 2)}
            />
            <Button
              variant="soft"
              color="gray"
              type="button"
              onClick={() =>
                void run(async () => {
                  const value = JSON.parse(
                    (
                      document.getElementById(
                        "assessment-case-json",
                      ) as HTMLTextAreaElement
                    ).value,
                  );
                  if (
                    !Array.isArray(value) ||
                    !value.length ||
                    value.length > 256
                  )
                    throw Error("请提供1–256组用例");
                  const next = value.map((t, i) => ({
                    ...t,
                    id: t.id || crypto.randomUUID(),
                    title: t.title || `用例 ${i + 1}`,
                    hidden: !!t.hidden,
                  }));
                  if (
                    next.some(
                      (t) =>
                        !t.inputs ||
                        !t.expected ||
                        Object.keys(t.inputs).sort().join("|") !==
                          Object.keys(next[0].inputs).sort().join("|") ||
                        Object.keys(t.expected).sort().join("|") !==
                          Object.keys(next[0].expected).sort().join("|"),
                    )
                  )
                    throw Error("每组用例需要相同的输入、输出标签");
                  patch({ tests: next });
                  setCount(String(next.length));
                  setInputNames(Object.keys(next[0].inputs).join(", "));
                  setOutputNames(Object.keys(next[0].expected).join(", "));
                })
              }
            >
              应用 JSON
            </Button>
          </details>
        </Tabs.Content>
      </Tabs.Root>
    </form>
  );
}
