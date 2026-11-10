import { useLayoutEffect, useRef, type RefObject } from "react";

/** Grows a text area with what it holds, up to its CSS `max-height`, the way
 * chat composers do instead of showing a resize grip. */
export function useAutoSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  const sized = useRef<{
    node: HTMLTextAreaElement;
    value: string;
    width: number;
  } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      if (
        sized.current?.node === node &&
        sized.current.value === value &&
        sized.current.width === width
      )
        return;
      sized.current = { node, value, width };
      // A mounting/collapsed pane can be zero-width. WebKit then measures
      // even its placeholder as many wrapped lines. Empty inputs use their
      // CSS minimum; actual text is measured once the pane has a width.
      node.style.height = "0px";
      if (!value || !width) return;
      const borders = node.offsetHeight - node.clientHeight;
      node.style.height = `${node.scrollHeight + borders}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  });
}
