export const shortcutCommands = [
  { id: "select", label: "选择", group: "工具", key: "1" },
  { id: "wire", label: "布线", group: "工具", key: "2" },
  { id: "poke", label: "操作输入", group: "工具", key: "3" },
  { id: "pan", label: "平移", group: "工具", key: "4" },
  { id: "palette", label: "添加元件", group: "工具", key: "A" },
  { id: "rotate", label: "旋转待放置元件", group: "工具", key: "R" },
  { id: "save", label: "保存", group: "编辑与视图", key: "Mod+S" },
  { id: "undo", label: "撤销", group: "编辑与视图", key: "Mod+Z" },
  { id: "find", label: "查找元件", group: "编辑与视图", key: "Mod+F" },
  { id: "circuitSearch", label: "查找电路", group: "编辑与视图", key: "/" },
  { id: "fit", label: "适合窗口", group: "编辑与视图", key: "F" },
  { id: "grid", label: "显示 / 隐藏网格", group: "编辑与视图", key: "G" },
  { id: "rail", label: "展开 / 收起项目栏", group: "编辑与视图", key: "Mod+B" },
  {
    id: "review",
    label: "展开 / 收起工作栏",
    group: "编辑与视图",
    key: "Mod+Alt+B",
  },
  { id: "clock", label: "运行 / 暂停时钟", group: "仿真", key: "Mod+K" },
  { id: "tick", label: "时钟一步", group: "仿真", key: "Mod+T" },
  { id: "propagation", label: "启用 / 暂停传播", group: "仿真", key: "Mod+E" },
  { id: "step", label: "传播一步", group: "仿真", key: "Mod+I" },
  { id: "reset", label: "复位仿真", group: "仿真", key: "Mod+R" },
  { id: "capture", label: "记录仿真时刻", group: "仿真", key: "F6" },
] as const;
export type ShortcutId = (typeof shortcutCommands)[number]["id"];
export type Bindings = Record<ShortcutId, string | null>;
export const defaultBindings = Object.fromEntries(
  shortcutCommands.map((c) => [c.id, c.key]),
) as Bindings;
const modifiers = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
const reserved = new Map([
  ["Mod+,", "快捷键设置"],
  ["Mod+C", "复制"],
  ["Mod+X", "剪切"],
  ["Mod+V", "粘贴"],
  ["Mod+A", "全选"],
  ["Mod+Shift+V", "粘贴"],
  ["Mod+Shift+Z", "重做"],
  ["Mod+Y", "重做"],
  ["Mod+Shift+O", "新对话"],
  ["Mod+Shift+N", "新建文件夹"],
  ["Alt+ArrowLeft", "返回上个位置"],
  ["Mod+Shift+S", "另存为"],
  ["Mod+N", "新建文件"],
  ["Mod+O", "打开文件"],
  ["Mod+W", "关闭文档"],
  ["F5", "刷新"],
  ["Mod+Q", "退出应用"],
  ["Alt+F4", "关闭窗口"],
  ["Mod+L", "地址栏"],
  ["Mod+Shift+I", "开发者工具"],
]);
const navigation = new Set([
  "Escape",
  "Enter",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
export function normalizeBinding(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parts = value.split("+"),
    key = parts.pop()!,
    mods = parts.filter((p) => modifiers.includes(p));
  if (
    !key ||
    mods.length !== parts.length ||
    new Set(mods).size !== mods.length
  )
    return undefined;
  if (
    !/^[A-Z0-9,./;'\[\]\\=`-]$/.test(key) &&
    !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) &&
    !navigation.has(key)
  )
    return undefined;
  if (mods.includes("Mod") && (mods.includes("Ctrl") || mods.includes("Meta")))
    return undefined;
  return [...modifiers.filter((m) => mods.includes(m)), key].join("+");
}
export function eventBinding(
  event: KeyboardEvent,
  mac = isMac(),
): string | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState?.("AltGraph")
  )
    return null;
  if (
    ["Control", "Meta", "Alt", "Shift", "Dead", "Unidentified"].includes(
      event.key,
    )
  )
    return null;
  const key = event.code?.startsWith("Digit")
    ? event.code.slice(5)
    : mac && event.altKey && event.code?.startsWith("Key")
      ? event.code.slice(3)
      : event.key === " "
        ? "Space"
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key;
  const mods = [];
  if (mac ? event.metaKey : event.ctrlKey) mods.push("Mod");
  if (mac ? event.ctrlKey : event.metaKey) mods.push(mac ? "Ctrl" : "Meta");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  return normalizeBinding([...mods, key].join("+")) || null;
}
export function bindingLabel(binding: string | null, mac = isMac()): string {
  return (
    binding
      ?.split("+")
      .map((part) =>
        part === "Mod" ? (mac ? "⌘" : "Ctrl") : part === "Meta" ? "⌘" : part,
      )
      .join("+") || "未设置"
  );
}
export function bindingProblem(
  id: ShortcutId,
  binding: string | null | undefined,
  bindings: Bindings,
): string | null {
  if (binding === null) return null;
  if (!binding || normalizeBinding(binding) !== binding)
    return "不支持这个组合键";
  if (navigation.has(binding.split("+").at(-1)!))
    return "此键保留用于确认、取消、导航或删除";
  if (reserved.has(binding))
    return `此快捷键保留用于「${reserved.get(binding)}」`;
  const other = shortcutCommands.find(
    (c) => c.id !== id && bindings[c.id] === binding,
  );
  return other ? `已用于「${other.label}」，请选择其他键` : null;
}
export function loadBindings(value: unknown): Bindings {
  const next = { ...defaultBindings };
  if (!value || typeof value !== "object" || Array.isArray(value)) return next;
  for (const item of shortcutCommands) {
    const raw = (value as Record<string, unknown>)[item.id];
    if (raw === undefined) continue;
    const normalized = normalizeBinding(
      typeof raw === "string" && raw.length === 1 ? raw.toUpperCase() : raw,
    );
    if (normalized === undefined) return { ...defaultBindings };
    next[item.id] = normalized;
  }
  return shortcutCommands.some((c) => bindingProblem(c.id, next[c.id], next))
    ? { ...defaultBindings }
    : next;
}
