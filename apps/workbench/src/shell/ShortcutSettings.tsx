import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  bindingLabel,
  bindingProblem,
  defaultBindings,
  eventBinding,
  shortcutCommands,
  type Bindings,
  type ShortcutId,
} from "../shared/shortcuts";
export function ShortcutSettings({
  bindings,
  onChange,
  onClose,
}: {
  bindings: Bindings;
  onChange: (value: Bindings) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const change = (id: ShortcutId, value: string | null) => {
    const problem = bindingProblem(id, value, bindings);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      onChange({ ...bindings, [id]: value });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <dialog
      ref={dialog}
      className="settings-dialog shortcut-settings"
      aria-label="快捷键"
      onCancel={onClose}
    >
      <header>
        快捷键
        <button aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <input
        autoFocus
        aria-label="查找快捷键"
        placeholder="查找命令或快捷键"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="shortcut-list">
        {[...new Set(shortcutCommands.map((c) => c.group))].map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            {shortcutCommands
              .filter(
                (c) =>
                  c.group === group &&
                  (c.label + bindingLabel(bindings[c.id]))
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              )
              .map((c) => (
                <label key={c.id}>
                  <span>{c.label}</span>
                  <input
                    readOnly
                    aria-label={c.label + " 快捷键"}
                    value={bindingLabel(bindings[c.id])}
                    onKeyDown={(e) => {
                      if (["Tab", "Escape"].includes(e.key)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const binding = eventBinding(e.nativeEvent);
                      if (binding) change(c.id, binding);
                    }}
                  />
                  <button
                    aria-label={`清除 ${c.label} 快捷键`}
                    onClick={() => change(c.id, null)}
                  >
                    <X size={12} />
                  </button>
                </label>
              ))}
          </section>
        ))}
      </div>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          onClick={() => {
            try {
              onChange({ ...defaultBindings });
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          恢复默认
        </button>
      </footer>
    </dialog>
  );
}
