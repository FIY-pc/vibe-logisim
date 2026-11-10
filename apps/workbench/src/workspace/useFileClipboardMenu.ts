import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { desktop } from "../shared/transport";
import { isMac } from "../shared/shortcuts";

export type FileClipboardAction = "cut" | "copy" | "paste";

/** macOS menu accelerators can consume Cmd+X/C/V before DOM keydown. */
export function useFileClipboardMenu(
  ownsFocus: () => boolean,
  run: (action: FileClipboardAction) => void,
  onError: (error: unknown) => void,
) {
  const latest = useRef({ ownsFocus, run, onError });
  latest.current = { ownsFocus, run, onError };
  useEffect(() => {
    if (!desktop() || !isMac()) return;
    let stopped = false;
    let focused = false;
    const sync = () => {
      const next = !stopped && latest.current.ownsFocus();
      if (next === focused) return;
      focused = next;
      void invoke("file_clipboard_focus", { focused }).catch((error) =>
        latest.current.onError(error),
      );
    };
    const unlisten = listen<FileClipboardAction>(
      "file-clipboard",
      ({ payload }) => {
        if (!stopped && latest.current.ownsFocus()) latest.current.run(payload);
      },
    );
    void unlisten
      .then(() => {
        if (!stopped) sync();
      })
      .catch(onError);
    document.addEventListener("focusin", sync);
    // At focusout, activeElement can temporarily be body; wait for focusin.
    const blur = () => queueMicrotask(sync);
    document.addEventListener("focusout", blur);
    return () => {
      stopped = true;
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", blur);
      sync();
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);
}
