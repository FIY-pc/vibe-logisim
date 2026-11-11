import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../shared/transport";
import { nativeDropPoint } from "../workspace/useFileDragHover";

/** Tauri receives native file drops before the DOM. Feed its images into the
 * same assistant-ui attachment adapter as clipboard and picker files. */
export function useImageDrop(
  ready: boolean,
  addImage: (file: File) => Promise<void>,
  onError: (error: unknown) => void,
  scope = "",
) {
  const [hovering, setHovering] = useState(false);
  const latest = useRef({ addImage, onError });
  latest.current = { addImage, onError };
  useEffect(() => {
    if (!ready || !desktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        const off = await getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (disposed) return;
          if (payload.type === "leave") {
            setHovering(false);
            return;
          }
          const { x, y } = nativeDropPoint(payload.position);
          const target = document
            .elementFromPoint(x, y)
            ?.closest("[data-image-drop]");
          setHovering(Boolean(target) && payload.type !== "drop");
          if (!target || payload.type !== "drop") return;
          const add = latest.current.addImage;
          for (const path of payload.paths.filter((value) =>
            /\.(png|jpe?g|webp)$/i.test(value),
          )) {
            void invoke<{ name: string; mime: string; data: string }>(
              "read_chat_image",
              { path },
            )
              .then(async (image) => {
                if (disposed) return;
                const bytes = Uint8Array.from(atob(image.data), (c) =>
                  c.charCodeAt(0),
                );
                await add(new File([bytes], image.name, { type: image.mime }));
              })
              .catch((error) => {
                if (!disposed) latest.current.onError(error);
              });
          }
        });
        if (disposed) off();
        else unlisten = off;
      })
      .catch((error) => {
        if (!disposed) latest.current.onError(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
      setHovering(false);
    };
  }, [ready, scope]);
  return hovering;
}
