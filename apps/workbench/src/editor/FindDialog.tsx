import { Text } from "../design/ui";
import { Command } from "cmdk";

import {
  CommandButton,
  CommandSearch,
  preventComposingDismiss,
} from "../shared/command";
import type { Circuit, Document } from "../shared/types";
import { DialogFrame, DialogBody } from "../shared/Dialog";
const names: Record<string, string> = {
  Register: "寄存器",
  Tunnel: "隧道",
  Pin: "引脚",
  Probe: "探针",
  Clock: "时钟",
  Multiplexer: "多路选择器",
  Splitter: "分线器",
  ROM: "只读存储器",
  RAM: "存储器",
  Button: "按钮",
  Constant: "常量",
  Adder: "加法器",
  Comparator: "比较器",
  Text: "文字",
};
export function FindDialog({
  mode,
  doc,
  circuit,
  onChoose,
  onClose,
}: {
  mode: "component" | "circuit";
  doc: Document;
  circuit: Circuit;
  onChoose: (circuit: string, component?: string) => void;
  onClose: () => void;
}) {
  const title = mode === "circuit" ? "查找电路" : "查找元件";
  const placeholder = mode === "circuit" ? "电路名称" : "元件名称或标签";
  const items =
    mode === "circuit"
      ? doc.circuits.map((c) => ({
          id: c.name,
          label: c.name,
          detail: "",
          circuit: c.name,
          component: undefined,
        }))
      : circuit.components.map((c) => ({
          id: c.id,
          label:
            c.attributes.label || c.attributes.text || names[c.name] || c.name,
          detail: `${names[c.name] || c.name} · ${c.location.x}, ${c.location.y}`,
          search: c.name,
          circuit: circuit.name,
          component: c.id,
        }));
  return (
    <DialogFrame
      title={title}
      onClose={onClose}
      className="find-dialog"
      maxWidth="560px"
      align="start"
      onEscapeKeyDown={preventComposingDismiss}
    >
      <DialogBody>
        <Command
          label={title}
          filter={(_value, search, keywords = []) => {
            const [label = "", ...detail] = keywords;
            const query = search.toLocaleLowerCase().trim();
            const haystack = [label, ...detail].join(" ").toLocaleLowerCase();
            if (!query.split(/\s+/).every((part) => haystack.includes(part)))
              return 0;
            return label.toLocaleLowerCase() === query
              ? 1
              : label.toLocaleLowerCase().startsWith(query)
                ? 0.75
                : 0.5;
          }}
        >
          <CommandSearch
            data-autofocus
            aria-label={placeholder}
            placeholder={placeholder}
          />
          <Command.List className="command-list find-results" label={title}>
            {items.map((item) => (
              <Command.Item
                asChild
                key={item.id}
                value={item.id}
                keywords={[
                  item.label,
                  item.detail,
                  "search" in item ? item.search : "",
                ]}
                onSelect={() => {
                  onChoose(item.circuit, item.component);
                  onClose();
                }}
              >
                <CommandButton variant="ghost" color="gray">
                  <Text>{item.label}</Text>
                  <Text color="gray">{item.detail}</Text>
                </CommandButton>
              </Command.Item>
            ))}
            <Command.Empty>
              <Text as="p" color="gray">
                没有匹配的结果
              </Text>
            </Command.Empty>
          </Command.List>
        </Command>
      </DialogBody>
    </DialogFrame>
  );
}
