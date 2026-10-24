import { useEffect, useState } from "react";
import { DialogClose, useModal } from "./Dialog";
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
    // A file name starts with its stem selected, as file managers do.
    const extension = /\.[\w-]{1,8}$/.exec(initial);
    if (extension?.index)
      dialog.current
        ?.querySelector("input")
        ?.setSelectionRange(0, extension.index);
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
          <h2>{title}</h2>
          <DialogClose disabled={pending} onClick={onClose} />
        </header>
        <input
          data-autofocus
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
