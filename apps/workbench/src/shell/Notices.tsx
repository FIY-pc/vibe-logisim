import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useNotices } from "../app/hooks";

const NOTICE_TIME = 6000;

/** The current notice. It goes away by itself after a few seconds, unless the
 * pointer or focus is on it. */
export function Notice() {
  const notice = useNotices((state) => state.notice);
  const setNotice = useNotices((state) => state.setNotice);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!notice || held) return;
    const timer = setTimeout(
      () => setNotice((current) => (current === notice ? "" : current)),
      NOTICE_TIME,
    );
    return () => clearTimeout(timer);
  }, [notice, held, setNotice]);
  if (!notice) return null;
  return (
    <div
      className="capture-notice"
      role="status"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span>{notice}</span>
      <button aria-label="关闭提示" onClick={() => setNotice("")}>
        <X size={13} />
      </button>
    </div>
  );
}

/** The current error. */
export function ErrorBar() {
  const error = useNotices((state) => state.error);
  const setError = useNotices((state) => state.setError);
  if (!error) return null;
  return (
    <div className="error-bar" role="alert">
      <span>{error}</span>
      <button aria-label="关闭错误" onClick={() => setError("")}>
        <X size={15} />
      </button>
    </div>
  );
}
