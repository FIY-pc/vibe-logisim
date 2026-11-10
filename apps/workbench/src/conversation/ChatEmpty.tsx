import type { ReactNode } from "react";
import {
  CircuitBoard,
  MessagesSquare,
  PlugZap,
  LoaderCircle,
} from "lucide-react";
import { Button } from "../design/ui";
import "./ChatEmpty.css";

type Phase = "start" | "connecting" | "error" | "configure" | "ready";

/** A small invitation inside the editor's conversation pane. */
export function ChatEmpty({
  phase,
  documentName,
  standalone,
  onStart,
  onConfigure,
  onReconnect,
  children,
}: {
  phase: Phase;
  documentName?: string;
  standalone: boolean;
  onStart?: () => void;
  onConfigure: () => void;
  onReconnect: () => void;
  children?: ReactNode;
}) {
  const Icon =
    phase === "connecting"
      ? LoaderCircle
      : phase === "error"
        ? PlugZap
        : phase === "ready"
          ? CircuitBoard
          : MessagesSquare;
  return (
    <section
      className="chat-empty"
      data-phase={phase}
      aria-label="开始 AI 对话"
    >
      <div className="chat-empty-symbol" aria-hidden="true">
        <Icon size={24} strokeWidth={1.5} />
      </div>
      {phase === "connecting" ? (
        <>
          <h3 role="status">正在准备对话…</h3>
          <p>马上就可以和 AI 一起设计电路。</p>
        </>
      ) : phase === "error" ? (
        <>
          <h3>暂时无法连接 AI</h3>
          <p>电路仍可正常编辑。重新连接后，继续这次对话。</p>
          <Button onClick={onReconnect}>重新连接</Button>
        </>
      ) : phase === "start" ? (
        <>
          <h3>和 AI 一起设计电路</h3>
          <p>新建或打开一个电路，就可以让 AI 帮你搭建、讲解和检查。</p>
          {onStart && <Button onClick={onStart}>新建电路</Button>}
        </>
      ) : phase === "configure" ? (
        <>
          <h3>让 AI 帮你设计电路</h3>
          <p>描述想实现的功能，一起搭建电路、理解原理，或找出连线中的问题。</p>
          <Button onClick={onConfigure}>连接 AI</Button>
          <small>登录 ChatGPT，或使用自己的 API 服务</small>
        </>
      ) : (
        <>
          <h3>从哪里开始？</h3>
          {documentName && (
            <span className="chat-empty-context" title={documentName}>
              当前电路 · {documentName}
            </span>
          )}
          <p>描述你的想法，或从一个具体任务开始。</p>
          {children}
          <small>
            {standalone
              ? "修改会显示在画布上，可撤销；保存后写入文件。"
              : "结合项目中的电路和资料提问，随时查看或撤销改动。"}
          </small>
        </>
      )}
    </section>
  );
}
