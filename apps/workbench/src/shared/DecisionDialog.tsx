import { Button } from "../design/ui";
import { useState } from "react";
import { AlertDialog, Callout, Flex } from "@radix-ui/themes";
import { useDialogFocus } from "./Dialog";

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
  const focus = useDialogFocus();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialog.Content
        {...focus}
        maxWidth="480px"
        maxHeight="var(--dialog-max-height)"
        className="decision-dialog"
        aria-label={decision.title}
      >
        <AlertDialog.Title size="5" className="dialog-title">
          {decision.title}
        </AlertDialog.Title>
        <AlertDialog.Description size="2">
          {decision.message}
        </AlertDialog.Description>
        {error && (
          <Callout.Root color="red" role="alert" mt="4">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Flex gap="3" mt="5" justify="end" wrap="wrap">
          <Button
            data-autofocus
            color="gray"
            variant="soft"
            disabled={pending}
            onClick={onClose}
          >
            取消
          </Button>
          {decision.actions.map((action) => (
            <Button
              key={action.label}
              variant={action.primary ? "solid" : "soft"}
              disabled={pending}
              onClick={() => {
                if (pending) return;
                setPending(true);
                setError("");
                void action
                  .run()
                  .then((done) => {
                    if (done !== false) onClose();
                  })
                  .catch((error) =>
                    setError(
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
                  .finally(() => setPending(false));
              }}
            >
              {action.label}
            </Button>
          ))}
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
