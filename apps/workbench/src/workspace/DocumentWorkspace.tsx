import { useEffect, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { CircuitBoard, Columns2, FileText, Square, X } from "lucide-react";
import { IconButton } from "../design/ui";
import { useDocuments, useFiles, useShell, useView } from "../app/hooks";
import { useWorkbench } from "../app/provider";
import { FilePreviewRegion } from "./FilePreviewRegion";
import { readerKey } from "./reader/types";

/** Files are peers; subcircuits remain navigation within a circuit document.
 * Focus and split layout are explicit state, independent of viewport width. */
export function DocumentWorkspace({ children }: { children: ReactNode }) {
  const { stores, actions } = useWorkbench();
  const view = useView();
  const { doc } = view;
  const docs = useDocuments((state) => state.docs);
  const readers = useFiles((state) => state.readers);
  const preview = useFiles((state) => state.preview);
  const focus = useFiles((state) => state.editorFocus);
  const mode = useFiles((state) => state.readerMode);
  const pending = useShell((state) => state.pending);
  const files = stores.files.getState();
  const group = useGroupRef();
  const split = mode === "split" && !!doc && !!preview;
  const materialActive = !!preview && (focus === "material" || !doc);
  const showCircuit = split || !materialActive;
  const showMaterial = !!preview && (split || materialActive);
  const circuitKey = `circuit:${doc?.id ?? "empty"}`;
  const materialKey = preview
    ? `material:${readerKey(preview)}`
    : "material:empty";

  useEffect(() => {
    let current = true;
    // The panels publish their new constraints before changing the layout.
    queueMicrotask(() => {
      if (!current) return;
      const material = split
        ? stores.files.getState().readerShare
        : showMaterial
          ? 100
          : 0;
      group.current?.setLayout({ circuit: 100 - material, material });
    });
    return () => {
      current = false;
    };
  }, [split, showMaterial, group, stores]);

  const activate = (key: string) => {
    if (key.startsWith("circuit:")) {
      const target = docs.find((item) => `circuit:${item.id}` === key);
      if (target) actions.navigation.activateDocument(view, target);
    } else {
      const target = readers.find(
        (item) => `material:${readerKey(item)}` === key,
      );
      if (target) files.setPreview(target);
    }
  };

  return (
    <Tabs.Root
      className="document-workspace"
      value={materialActive ? materialKey : circuitKey}
      onValueChange={activate}
      activationMode="manual"
      data-layout={split ? "split" : "single"}
    >
      {(docs.length > 0 || readers.length > 0) && (
        <header className="document-header">
          <Tabs.List className="document-tabs" aria-label="打开的文档">
            {docs.map((item) => (
              <div className="document-tab" key={`circuit:${item.id}`}>
                <Tabs.Trigger
                  value={`circuit:${item.id}`}
                  title={item.path || item.name}
                >
                  <CircuitBoard size={16} />
                  <span className="document-tab-name">{item.name}</span>
                  {item.dirty && (
                    <span
                      className="dirty-dot"
                      role="img"
                      aria-label="有未保存的修改"
                    />
                  )}
                </Tabs.Trigger>
                <IconButton
                  aria-label={`关闭文档 ${item.name}`}
                  disabled={!!pending}
                  onClick={() => actions.workspace.requestClose(item)}
                >
                  <X size={16} />
                </IconButton>
              </div>
            ))}
            {readers.map((file) => (
              <div className="document-tab" key={`material:${readerKey(file)}`}>
                <Tabs.Trigger
                  value={`material:${readerKey(file)}`}
                  title={file.path || file.name}
                >
                  <FileText size={16} />
                  <span className="document-tab-name">{file.name}</span>
                </Tabs.Trigger>
                <IconButton
                  aria-label={`关闭文档 ${file.name}`}
                  onClick={() => files.closeReader(readerKey(file))}
                >
                  <X size={16} />
                </IconButton>
              </div>
            ))}
          </Tabs.List>
          {doc && preview && (
            <IconButton
              aria-label={split ? "单栏查看" : "并排查看电路与资料"}
              data-tip={split ? "单栏查看" : "并排查看电路与资料"}
              aria-pressed={split}
              onClick={() => files.setReaderMode(split ? "single" : "split")}
            >
              {split ? <Square size={16} /> : <Columns2 size={16} />}
            </IconButton>
          )}
        </header>
      )}
      <Group
        className="document-panes"
        id="document-panes"
        groupRef={group}
        disabled={!split}
        onLayoutChanged={(sizes, { isUserInteraction }) => {
          if (split && isUserInteraction) files.setReaderShare(sizes.material);
        }}
      >
        <Panel
          id="circuit"
          className="document-pane"
          defaultSize="50%"
          minSize={split ? "25%" : 0}
          maxSize={showCircuit ? undefined : 0}
        >
          <Tabs.Content
            value={circuitKey}
            forceMount
            hidden={!showCircuit}
            className="document-content"
            onPointerDownCapture={() => files.showCircuit()}
            onFocusCapture={() => files.showCircuit()}
          >
            {children}
          </Tabs.Content>
        </Panel>
        <Separator
          className="panel-resizer"
          aria-label="调整电路与资料宽度"
          disabled={!split}
          style={{ display: split ? undefined : "none" }}
        />
        <Panel
          id="material"
          className="document-pane"
          defaultSize="50%"
          minSize={split ? "25%" : 0}
          maxSize={showMaterial ? undefined : 0}
        >
          <Tabs.Content
            value={materialKey}
            forceMount
            hidden={!showMaterial}
            className="document-content"
            onPointerDownCapture={() => files.setEditorFocus("material")}
            onFocusCapture={() => files.setEditorFocus("material")}
          >
            <FilePreviewRegion />
          </Tabs.Content>
        </Panel>
      </Group>
    </Tabs.Root>
  );
}
