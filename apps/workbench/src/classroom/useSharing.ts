import { useEffect, useRef, useState } from "react";
import { classroomRequest, type ClassroomSession } from "./client";
import { prepareWork } from "./sharing";
import { command } from "../shared/transport";

interface SharingBinding {
  classroomId: string;
  folderId: string | null;
}
const storageKey = (session: ClassroomSession) =>
  `vibe.classroom.sync:${session.server}:${session.user.id}`;
export function savedClassroom(session: ClassroomSession) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(session)) || "null")
      ?.classroomId as string | undefined;
  } catch {
    return undefined;
  }
}
/** A student has one active classroom and a visible, persistent workspace binding. */
export function useSharing(
  session: ClassroomSession | null,
  documentId?: string,
) {
  const [binding, setBinding] = useState<SharingBinding | null>(null);
  const [status, setStatus] = useState("");
  const latestDocument = useRef(documentId),
    last = useRef(""),
    generation = useRef(0);
  const immediate = useRef<((submit?: boolean) => Promise<void>) | null>(null);
  latestDocument.current = documentId;
  useEffect(() => {
    last.current = "";
    if (session?.user.role !== "student") {
      setBinding(null);
      return;
    }
    try {
      setBinding(
        JSON.parse(localStorage.getItem(storageKey(session)) || "null"),
      );
    } catch {
      setBinding(null);
    }
  }, [session]);
  useEffect(() => {
    const current = ++generation.current;
    if (!binding || !session || session.user.role !== "student") return;
    let busy = false;
    const controller = new AbortController();
    const sync = async (submit = false) => {
      if (busy) {
        if (submit) throw new Error("正在同步，请稍候再提交");
        return;
      }
      busy = true;
      try {
        if (!latestDocument.current) {
          if (submit) throw new Error("请先打开要提交的课堂电路");
          setStatus("等待打开本课堂电路，之后自动同步");
          return;
        }
        const context = await command<any>({ op: "status", summary: true });
        const folderId = context.folder?.id;
        if (generation.current !== current) return;
        if (!folderId) {
          if (submit) throw new Error("请先打开本课堂的工作文件夹");
          setStatus("请先打开本课堂的工作文件夹");
          return;
        }
        if (binding.folderId && binding.folderId !== folderId) {
          if (submit)
            throw new Error("工作文件夹已变化，请先绑定当前工作文件夹");
          setStatus("已切换到其他工作文件夹，本课堂同步已暂停");
          return;
        }
        if (!binding.folderId) {
          const bound = { ...binding, folderId };
          localStorage.setItem(storageKey(session), JSON.stringify(bound));
          setBinding(bound);
          return;
        }
        const { snapshot } = await prepareWork(latestDocument.current, true);
        if (generation.current !== current) return;
        const fingerprint = JSON.stringify(snapshot);
        if (!submit && last.current === fingerprint) return;
        await classroomRequest(
          session,
          `/classrooms/${binding.classroomId}/submissions`,
          "POST",
          {
            id: crypto.randomUUID(),
            snapshot: { ...snapshot, status: submit ? "submitted" : "working" },
          },
          controller.signal,
        );
        if (generation.current === current) {
          last.current = fingerprint;
          setStatus(
            `${submit ? "已提交" : "已自动同步"} · ${new Date().toLocaleTimeString()}`,
          );
        }
      } catch (error) {
        if (generation.current !== current) return;
        const e = error as { code?: string; status?: number };
        setStatus(
          ["SHARING_BUSY", "STALE_REVISION"].includes(e.code || "")
            ? "AI 回合或电路编辑结束后自动继续同步"
            : "同步未完成，将自动重试：" +
                (error instanceof Error ? error.message : String(error)),
        );
        if (submit) throw error;
      } finally {
        busy = false;
      }
    };
    immediate.current = sync;
    void sync();
    const timer = setInterval(() => void sync(), 15000);
    return () => {
      ++generation.current;
      clearInterval(timer);
      controller.abort();
      immediate.current = null;
    };
  }, [binding, session]);
  return {
    binding,
    status,
    select: async (classroomId: string, rebind = false) => {
      if (!session || session.user.role !== "student") return;
      if (!rebind && binding?.classroomId === classroomId) return;
      const context = await command<any>({ op: "status", summary: true });
      const next = { classroomId, folderId: context.folder?.id || null };
      localStorage.setItem(storageKey(session), JSON.stringify(next));
      last.current = "";
      setStatus("本课堂自动同步已启用");
      setBinding(next);
    },
    syncNow: async (submit = false) => {
      if (!immediate.current) throw new Error("请先选择课堂并打开工作文件夹");
      await immediate.current(submit);
    },
  };
}
