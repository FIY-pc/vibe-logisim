import { useLayoutEffect, useRef, type RefObject } from "react";

/** Grows a text area with what it holds, up to its CSS `max-height`, the way
 * chat composers do instead of showing a resize grip. */
export function useAutoSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  const sized = useRef<{ node: HTMLTextAreaElement; value: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    const node = ref.current;
    if (
      !node ||
      (sized.current?.node === node && sized.current.value === value)
    )
      return;
    sized.current = { node, value };
    node.style.height = "auto";
    const borders = node.offsetHeight - node.clientHeight;
    node.style.height = `${node.scrollHeight + borders}px`;
  });
}
