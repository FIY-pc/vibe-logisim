import { useEffect, useState } from "react";
import { Callout, Flex } from "@radix-ui/themes";
import { Button, Text } from "../design/ui";
import { DialogBody, DialogFooter, DialogFrame } from "../shared/Dialog";
import { command } from "../shared/transport";
import type { Message } from "./ConversationContent";

type Page = { text: string; nextOffset?: number; bytes: number };
type Source = { id?: string; toolCallId?: string; bytes?: number };

/** Reads one bounded page at a time; large logs never accumulate in the DOM. */
function OutputDialog({
  artifact,
  item,
  onClose,
}: {
  artifact: Source;
  item: Message;
  onClose: () => void;
}) {
  const [offsets, setOffsets] = useState([0]);
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const offset = offsets[index];
  useEffect(() => {
    let current = true;
    setPage(null);
    setError("");
    void command<Page>({
      op: "agent",
      method: "readToolOutput",
      args: {
        workspaceKey: item.workspaceKey!,
        conversationId: item.conversationId!,
        ...(artifact.id
          ? { id: artifact.id }
          : { toolCallId: artifact.toolCallId! }),
        offset,
        limit: 64 * 1024,
      },
    })
      .then((result) => {
        if (!current) return;
        setPage(result);
      })
      .catch((reason) => {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
    };
  }, [
    artifact.id,
    artifact.toolCallId,
    item.workspaceKey,
    item.conversationId,
    offset,
    attempt,
  ]);
  return (
    <DialogFrame title="完整工具输出" maxWidth="900px" onClose={onClose}>
      <DialogBody
        key={offset}
        className="tool-output-body"
        aria-busy={!page && !error}
      >
        {error ? (
          <Callout.Root color="red" role="alert">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : page ? (
          <pre tabIndex={0}>{page.text || "（空输出）"}</pre>
        ) : (
          <Text role="status">正在读取…</Text>
        )}
      </DialogBody>
      <DialogFooter>
        <Text kind="meta" role="status">
          第 {index + 1} 页
          {page &&
            ` · ${offset.toLocaleString()}–${(page.nextOffset ?? page.bytes).toLocaleString()} / ${page.bytes.toLocaleString()} 字节`}
        </Text>
        {error && (
          <Button variant="soft" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </Button>
        )}
        <Button
          variant="soft"
          color="gray"
          disabled={index === 0 || (!page && !error)}
          onClick={() => setIndex((n) => n - 1)}
        >
          上一页
        </Button>
        <Button
          variant="soft"
          color="gray"
          disabled={page?.nextOffset === undefined}
          onClick={() => {
            if (page?.nextOffset === undefined) return;
            setOffsets([...offsets.slice(0, index + 1), page.nextOffset]);
            setIndex(index + 1);
          }}
        >
          下一页
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

export function ToolOutputAccess({ item }: { item: Message }) {
  const [selected, setSelected] = useState<Source | null>(null);
  const artifacts = item.toolOutput?.outputArtifacts || [];
  const transcript =
    !artifacts.length && item.toolOutput?.truncated && item.itemId;
  if (!artifacts.length && !transcript) return null;
  if (!item.workspaceKey || !item.conversationId)
    return <Text kind="meta">完整输出的会话引用不可用，请重新打开会话</Text>;
  return (
    <>
      <Flex gap="2" wrap="wrap">
        {transcript && (
          <Button
            variant="soft"
            color="gray"
            onClick={() => setSelected({ toolCallId: transcript })}
          >
            查看完整输出
          </Button>
        )}
        {artifacts.map((artifact, index) => (
          <Button
            key={artifact.id}
            variant="soft"
            color="gray"
            onClick={() => setSelected(artifact)}
          >
            查看完整输出{artifacts.length > 1 ? ` ${index + 1}` : ""}
          </Button>
        ))}
      </Flex>
      {selected && (
        <OutputDialog
          key={selected.id}
          artifact={selected}
          item={item}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
