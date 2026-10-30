import { useEffect, useRef, useState } from "react";
import { classroomRequest, type ClassroomSession } from "./client";
import { prepareWork, type ShareTarget } from "./sharing";

export interface SharingBinding {
  session: ClassroomSession;
  classroomId: string;
  target: ShareTarget;
  progress: number;
  note: string;
}
/** Lives beside the title bar, so closing the classroom dialog keeps the explicit sharing session alive. */
export function useSharing() {
  const [binding, setBinding] = useState<SharingBinding | null>(null),
    [status, setStatus] = useState("");
  const generation = useRef(0),
    last = useRef("");
  useEffect(() => {
    const current = ++generation.current;
    if (!binding) return;
    let busy = false;
    const controller = new AbortController();
    const sync = async () => {
      if (busy) return;
      busy = true;
      try {
        const { snapshot } = await prepareWork(
          binding.target.documentId,
          binding.target.includeConversation,
          binding.target,
        );
        if (generation.current !== current) return;
        Object.assign(snapshot, {
          progress: binding.progress,
          note: binding.note,
        });
        const fingerprint = JSON.stringify(snapshot);
        if (last.current === fingerprint) return;
        await classroomRequest(
          binding.session,
          `/classrooms/${binding.classroomId}/submissions`,
          "POST",
          { id: crypto.randomUUID(), snapshot },
          controller.signal,
        );
        if (generation.current === current) {
          last.current = fingerprint;
          setStatus("已共享 · " + new Date().toLocaleTimeString());
        }
      } catch (error) {
        if (generation.current === current) {
          if ((error as { code?: string })?.code === "SHARING_BUSY") {
            setStatus("等待当前 AI 回合结束后继续共享");
            return;
          }
          setStatus(
            "共享已暂停：" +
              (error instanceof Error ? error.message : String(error)),
          );
          setBinding(null);
        }
      } finally {
        busy = false;
      }
    };
    last.current = "";
    const timer = setInterval(() => void sync(), 30000);
    setStatus("自动共享已开启，每 30 秒检查选定电路和对话的变化");
    return () => {
      ++generation.current;
      clearInterval(timer);
      controller.abort();
    };
  }, [binding]);
  return {
    binding,
    status,
    start: setBinding,
    stop: () => {
      ++generation.current;
      setBinding(null);
      setStatus("自动共享已停止");
    },
  };
}
