/** Interactive fault scenarios. Transport and tools are real; model text is scripted. */
import type { Script } from "../scripted-model.mts";

const failed = new Set<string>();
const script: Script = ({ question, calls, request }) => {
  // The same projected request is retried after an interrupted response.
  const key = JSON.stringify(request.messages);
  const once = (kind: string) => {
    const id = kind + key;
    if (failed.has(id)) return false;
    failed.add(id);
    return true;
  };
  if (question.includes("鉴权失败"))
    return { errorStatus: 401, error: "invalid api key (local demonstration)" };
  if (question.includes("持续断网"))
    return {
      errorStatus: 503,
      error: "connection error (local demonstration)",
    };
  if (question.includes("限流恢复") && !calls.length && once("rate"))
    return { errorStatus: 429, error: "rate limit (local demonstration)" };
  if (question.trim() === "继续") {
    if (!calls.length)
      return {
        text: "先核对当前文件，保留上一次已经完成的改动。",
        tool: { name: "read_file", args: { path: "恢复记录.txt" } },
        delayMs: 700,
      };
    return {
      text: "已读取当前文件并继续完成检查。之前的文字、工具记录和文件改动均保留。\n\n这是本地故障演示，未调用外部模型。",
      delayMs: 700,
    };
  }
  if (question.includes("停止继续"))
    return {
      text: "这段内容会保留。点击输入框右下角的停止按钮后，空输入框会显示继续图标；输入新内容则恢复发送。",
      hold: true,
    };
  if (!question.includes("断线恢复") && !question.includes("限流恢复"))
    return {
      text: "这是本地故障演示服务。可以发送：**断线恢复**、**限流恢复**、**停止继续**、**鉴权失败**、**持续断网**。\n\n文件读写和网络故障由真实运行时处理；回答文本来自测试脚本，不消耗模型额度。",
    };
  if (!calls.length)
    return {
      text: "先读取恢复记录，再写入一条完成记录。",
      tool: { name: "read_file", args: { path: "恢复记录.txt" } },
      delayMs: 700,
    };
  if (calls.length === 1) {
    const content = typeof calls[0].result === "string" ? calls[0].result : "";
    return {
      text: "将这次操作记录到文件中。",
      tool: {
        name: "write_file",
        args: {
          path: "恢复记录.txt",
          content: content + `\n完成记录：${question}\n`,
        },
      },
      delayMs: 700,
    };
  }
  if (calls.length === 2 && question.includes("断线恢复") && once("disconnect"))
    return {
      text: "文件已经保存。接下来检查结果时，连接突然中断……",
      disconnectAfterMs: 1000,
    };
  if (calls.length === 2)
    return {
      text: "连接已恢复，保留已经完成的写入；现在读取文件核对。",
      tool: { name: "read_file", args: { path: "恢复记录.txt" } },
      delayMs: 700,
    };
  return {
    text: "已完成恢复并核对文件。\n\n- 本轮只写入了一条完成记录。\n- 已生成的内容和工具结果仍可展开查看。\n- 自动恢复期间没有重新发送原问题。\n\n这是本地故障演示，未调用外部模型。",
    delayMs: 700,
  };
};
export default script;
