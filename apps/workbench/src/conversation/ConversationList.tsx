import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { FollowLatest } from "./ConversationContent";
import { TurnExpansionProvider } from "./TurnExpansion";
import type { Segment } from "./turns";

export interface ConversationListHandle {
  latest(): void;
}
const List = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { context?: unknown }
>(function List({ context: _context, ...props }, ref) {
  return <div {...props} ref={ref} className="messages-content" />;
});
const Spacer = () => <div style={{ height: 16 }} />;
const Empty = ({ context }: { context?: { empty: ReactNode } }) => (
  <div className="conversation-segment">{context?.empty}</div>
);
const components = {
  List,
  Header: Spacer,
  Footer: Spacer,
  EmptyPlaceholder: Empty,
};

/** Key this component by conversation identity. Virtuoso alone measures and
 * scrolls the list; this view only decides when the reader wants to follow. */
export function ConversationList({
  items,
  visible,
  empty,
  renderItem,
  ref,
}: {
  items: Segment[];
  visible: boolean;
  empty: ReactNode;
  renderItem: (segment: Segment, index: number) => ReactNode;
  ref?: Ref<ConversationListHandle>;
}) {
  const list = useRef<VirtuosoHandle>(null);
  const [following, setFollowing] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const latest = () => {
    setFollowing(true);
    list.current?.scrollToIndex({ index: "LAST", align: "end" });
  };
  useImperativeHandle(ref, () => ({ latest }));
  return (
    <TurnExpansionProvider>
      <Virtuoso
        ref={list}
        className="messages conversation-messages"
        tabIndex={0}
        aria-label="对话消息"
        data={items}
        computeItemKey={(_, segment) => segment.key}
        components={components}
        context={{ empty }}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        followOutput={following ? "auto" : false}
        atBottomThreshold={32}
        atBottomStateChange={(value) => {
          setAtBottom(value);
          // A streamed paragraph temporarily moves the bottom, too. Only reader
          // input pauses following; arriving at the bottom resumes it.
          if (value) setFollowing(true);
        }}
        // Streaming can grow an existing turn without adding a row. The library
        // owns measurement and positioning; reader input owns the follow intent.
        totalListHeightChanged={() => {
          if (visible && following)
            list.current?.scrollToIndex({ index: "LAST", align: "end" });
        }}
        increaseViewportBy={200}
        onWheel={(event) => {
          if (event.deltaY < 0) setFollowing(false);
        }}
        onKeyDown={(event) => {
          if (["PageUp", "Home", "ArrowUp"].includes(event.key))
            setFollowing(false);
        }}
        onTouchStart={() => setFollowing(false)}
        onPointerDown={(event) => {
          // The scroller itself receives presses on its native scrollbar.
          if (event.target === event.currentTarget) setFollowing(false);
        }}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("summary, [aria-expanded]")
          )
            setFollowing(false);
        }}
        itemContent={(index, segment) => (
          <div className="conversation-segment" data-segment={segment.key}>
            {renderItem(segment, index)}
          </div>
        )}
      />
      {(!atBottom || !following) && items.length > 0 && (
        <FollowLatest onClick={latest} />
      )}
    </TurnExpansionProvider>
  );
}
