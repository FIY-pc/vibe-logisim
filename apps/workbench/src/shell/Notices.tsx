import { X } from "lucide-react";
import { useNotices } from "../app/hooks";

/** The current notice. */
export function Notice() {
  const notice = useNotices((state) => state.notice);
  const setNotice = useNotices((state) => state.setNotice);
  if (!notice) return null;
  return (
    <div className="capture-notice" role="status">
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
