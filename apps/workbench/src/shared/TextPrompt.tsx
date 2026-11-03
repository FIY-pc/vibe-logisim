import { useState } from "react";
import { Button, Callout, Dialog, Flex, TextField } from "@radix-ui/themes";
import { DialogClose, useDialogFocus } from "./Dialog";

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
  const focus = useDialogFocus();
  const [value, setValue] = useState(initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog.Content
        {...focus}
        className="prompt-dialog"
        aria-label={title}
        maxWidth="440px"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          focus.onOpenAutoFocus(event);
          const extension = /\.[\w-]{1,8}$/.exec(initial);
          if (extension?.index)
            focus.ref.current
              ?.querySelector("input")
              ?.setSelectionRange(0, extension.index);
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!value.trim() || pending) return;
            setPending(true);
            setError("");
            void onSubmit(value.trim())
              .then(onClose)
              .catch((error) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <Flex align="center" justify="between" gap="4">
            <Dialog.Title mb="0">{title}</Dialog.Title>
            <DialogClose disabled={pending} onClick={onClose} />
          </Flex>
          <TextField.Root
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
          <footer>
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
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
