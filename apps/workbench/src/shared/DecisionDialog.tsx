import { useEffect, useRef, useState } from "react";

export interface Decision {
  title: string;
  message: string;
  actions: {
    label: string;
    primary?: boolean;
    run: () => Promise<boolean | void>;
  }[];
}

export function DecisionDialog({
  decision,
  onClose,
}: {
  decision: Decision;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="text-prompt decision-dialog"
      aria-label={decision.title}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <header>{decision.title}</header>
      <p>{decision.message}</p>
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button data-cancel disabled={pending} onClick={onClose}>
          取消
        </button>
        {decision.actions.map((action) => (
          <button
            key={action.label}
            disabled={pending}
            className={action.primary ? "primary" : ""}
            onClick={() => {
              if (pending) return;
              setPending(true);
              setError("");
              void action
                .run()
                .then((done) => {
                  if (done !== false) onClose();
                })
                .catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                )
                .finally(() => setPending(false));
            }}
          >
            {action.label}
          </button>
        ))}
      </footer>
    </dialog>
  );
}
