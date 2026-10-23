import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useModal } from "./dialog";
export function TextPrompt({
  title,
  initial = "",
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useModal(),
    [value, setValue] = useState(initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.querySelector("input")?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="text-prompt"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
      aria-label={title}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim() || pending) return;
          setPending(true);
          setError("");
          void onSubmit(value.trim())
            .then(onClose)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setPending(false));
        }}
      >
        <header>
          {title}
          <button
            type="button"
            aria-label="关闭"
            disabled={pending}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <input
          autoFocus
          required
          aria-label={title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
        />
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button
            className="primary"
            type="submit"
            disabled={pending || !value.trim()}
          >
            {pending ? "正在处理…" : "确定"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
