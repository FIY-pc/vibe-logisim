import { useCallback, useEffect, useState } from "react";
import type { SourceStatus } from "../generated/SourceStatus";
import type { Document } from "./types";
import { command } from "./transport";

export function useSourceStatus(doc: Document | null) {
  const [record, setRecord] = useState<{
    id: string;
    revision: string;
    status: SourceStatus;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const recheck = useCallback(() => setRefresh((n) => n + 1), []);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let checking = false;
    const check = async () => {
      if (checking || !live) return;
      checking = true;
      clearTimeout(timer);
      try {
        const status = await command<SourceStatus>({
          op: "sourceStatus",
          id: doc.id,
        });
        if (live) setRecord({ id: doc.id, revision: doc.revision, status });
      } catch (e) {
        if (live)
          setRecord({
            id: doc.id,
            revision: doc.revision,
            status: { state: "unreadable", message: String(e) },
          });
      } finally {
        checking = false;
        if (live && doc.path) timer = setTimeout(check, 3000);
      }
    };
    const focus = () => void check();
    window.addEventListener("focus", focus);
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
    };
  }, [doc?.id, doc?.revision, doc?.path, doc?.dirty, refresh]);
  return {
    sourceStatus:
      record?.id === doc?.id && record?.revision === doc?.revision
        ? record?.status
        : undefined,
    recheck,
  };
}
