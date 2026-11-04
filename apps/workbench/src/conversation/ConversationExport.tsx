import { useState } from "react";
import { Callout, Flex } from "@radix-ui/themes";
import { Download } from "lucide-react";
import { Button, Text, TextField } from "../design/ui";
import { Checkbox } from "../shared/Checkbox";
import { DialogFrame, DialogBody, DialogFooter } from "../shared/Dialog";
import { command, desktop } from "../shared/transport";
import type { ConversationSummary } from "./ConversationContent";

export function ConversationExport({
  workspaceKey,
  workspaceName,
  conversations,
  onClose,
}: {
  workspaceKey: string;
  workspaceName: string;
  conversations: ConversationSummary[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacement, setReplacement] = useState<{
    path: string;
    revision: string;
  } | null>(null);
  const ids = conversations
    .filter((item) => selected.has(item.id))
    .map((item) => item.id);
  const shown = conversations.filter((item) =>
    [item.title, item.preview || ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const save = async () => {
    if (busy || !ids.length) return;
    setBusy(true);
    setError("");
    try {
      let path: string | undefined;
      if (desktop()) {
        if (replacement) path = replacement.path;
        else {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const chosen = await save({
            title: "导出会话",
            defaultPath: `conversations-${new Date().toISOString().slice(0, 10)}.zip`,
            filters: [{ name: "ZIP", extensions: ["zip"] }],
          });
          if (!chosen) return;
          path = chosen;
          const target = await command<{ revision: string | null }>({
            op: "projectExportTarget",
            path,
          });
          if (target.revision) {
            setReplacement({ path, revision: target.revision });
            return;
          }
        }
      }
      const result = await command<{ name: string; data?: string }>({
        op: "conversationExport",
        workspace_key: workspaceKey,
        ids,
        path,
        expected_revision: replacement?.revision,
      });
      if (result.data) {
        const bytes = Uint8Array.from(atob(result.data), (value) =>
          value.charCodeAt(0),
        );
        const url = URL.createObjectURL(
          new Blob([bytes], { type: "application/zip" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = result.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setReplacement(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogFrame
      title="导出会话"
      aria-label="导出会话"
      maxWidth="600px"
      onClose={onClose}
      closeDisabled={busy}
    >
      <DialogBody>
        <Flex direction="column" gap="3">
          <Text>当前工作区：{workspaceName}</Text>
          <Text color="gray">
            仅导出勾选的会话，包含消息、思考摘要及完整工具记录。每条会话提供
            Markdown 和 JSON，共同保存为一个 ZIP。
          </Text>
          <TextField.Root
            aria-label="查找要导出的会话"
            placeholder="查找会话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={busy || Boolean(replacement)}
          />
          <Flex gap="3" align="center" wrap="wrap">
            <Button
              variant="ghost"
              color="gray"
              disabled={busy || Boolean(replacement) || !shown.length}
              onClick={() =>
                setSelected(
                  (current) =>
                    new Set([...current, ...shown.map((item) => item.id)]),
                )
              }
            >
              {search.trim() ? "全选当前结果" : "全选"}
            </Button>
            <Button
              variant="ghost"
              color="gray"
              disabled={busy || Boolean(replacement) || !ids.length}
              onClick={() => setSelected(new Set())}
            >
              取消全选
            </Button>
            <Text kind="meta" color="gray" role="status">
              已选 {ids.length} / {conversations.length} 条
            </Text>
          </Flex>
          <Flex direction="column" gap="3" role="group" aria-label="工作区会话">
            {shown.map((item) => (
              <Flex asChild key={item.id} align="start" gap="3">
                <label>
                  <Checkbox
                    label={item.title}
                    checked={selected.has(item.id)}
                    disabled={busy || Boolean(replacement)}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                  <Flex direction="column" minWidth="0" gap="1">
                    <Text style={{ overflowWrap: "anywhere" }}>
                      {item.title}
                    </Text>
                    <Text kind="meta" color="gray">
                      {item.archived ? "已归档 · " : ""}
                      {item.updatedAt
                        ? new Date(item.updatedAt).toLocaleString()
                        : ""}
                    </Text>
                    {item.preview && (
                      <Text kind="meta" color="gray" truncate>
                        {item.preview}
                      </Text>
                    )}
                  </Flex>
                </label>
              </Flex>
            ))}
            {!shown.length && <Text color="gray">没有匹配的会话</Text>}
          </Flex>
        </Flex>
      </DialogBody>
      <DialogFooter>
        {error && (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        {replacement && <Text>文件已存在，替换「{replacement.path}」？</Text>}
        <Button
          variant="soft"
          color="gray"
          disabled={busy}
          onClick={() => (replacement ? setReplacement(null) : onClose())}
        >
          取消
        </Button>
        <Button disabled={!ids.length || busy} onClick={() => void save()}>
          <Download size={16} />
          {busy
            ? "正在导出…"
            : replacement
              ? "替换文件"
              : `导出会话（${ids.length}）`}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
