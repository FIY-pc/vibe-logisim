import { Button, TextField } from "../design/ui";
import { useRef, useState } from "react";
import { Callout } from "@radix-ui/themes";
import { DialogFrame, DialogBody, DialogFooter } from "./Dialog";

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
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <DialogFrame
      title={title}
      className="input-dialog"
      aria-label={title}
      maxWidth="440px"
      onClose={onClose}
      closeDisabled={pending}
      onOpenAutoFocus={() => {
        const extension = /\.[\w-]{1,8}$/.exec(initial);
        if (extension?.index)
          input.current?.setSelectionRange(0, extension.index);
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || pending) return;
          setPending(true);
          setError("");
          void onSubmit(value.trim())
            .then(onClose)
            .catch((error) =>
              setError(error instanceof Error ? error.message : String(error)),
            )
            .finally(() => setPending(false));
        }}
      >
        <DialogBody>
          <TextField.Root
            ref={input}
            data-autofocus
            required
            aria-label={title}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={pending}
          />
          {error && (
            <Callout.Root color="red" role="alert">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="soft"
            color="gray"
            onClick={onClose}
            disabled={pending}
          >
            取消
          </Button>
          <Button type="submit" loading={pending} disabled={!value.trim()}>
            确定
          </Button>
        </DialogFooter>
      </form>
    </DialogFrame>
  );
}
