import { useEffect, useState } from "react";
import { command } from "../shared/transport";
import type { CatalogTool, Circuit, Document, XmlNode } from "../shared/types";
export interface PlacementState {
  tool: CatalogTool | null;
  template: XmlNode | null;
  attributes: Record<string, string>;
  loading: boolean;
  error: string;
  repeat: boolean;
  setRepeat: (repeat: boolean) => void;
  change: (attributes: Record<string, string>) => void;
  rotate: () => void;
  retry?: () => void;
}
/** Whether rotation can turn the placed component: its template has loaded and has a facing. */
export const canRotate = (placement: PlacementState) =>
  Boolean(placement.template?.attributes.facingAttribute) && !placement.loading;
export function usePlacement(
  doc: Document | null,
  circuit: Circuit | undefined,
  tool: CatalogTool | null,
): PlacementState {
  const preference = `${doc?.id}:${tool?.library}:${tool?.name}`;
  const scope = `${preference}:${circuit?.name}`;
  const [preferences, setPreferences] = useState<
    Record<string, Record<string, string>>
  >({});
  const attributes = preferences[preference] || {};
  const attributeKey = JSON.stringify(attributes);
  const [result, setResult] = useState<{
    scope: string;
    attributes: string;
    template: XmlNode;
  } | null>(null);
  const [status, setStatus] = useState({
    scope: "",
    attributes: "",
    loading: false,
    error: "",
  });
  const [repeat, setRepeat] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);
  const template =
    result?.scope === scope && result.attributes === attributeKey
      ? result.template
      : null;
  useEffect(() => {
    if (!doc || !circuit || !tool) return;
    let live = true;
    setStatus({ scope, attributes: attributeKey, loading: true, error: "" });
    void command<XmlNode>({
      op: "template",
      id: doc.id,
      revision: doc.revision,
      circuit: circuit.name,
      library: tool.library || undefined,
      name: tool.name,
      attributes,
    })
      .then((template) => {
        if (live) {
          setResult({ scope, attributes: attributeKey, template });
          setStatus({
            scope,
            attributes: attributeKey,
            loading: false,
            error: "",
          });
        }
      })
      .catch((error) => {
        if (live)
          setStatus({
            scope,
            attributes: attributeKey,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      live = false;
    };
    // A placement default depends on the tools and circuit, not on the edits.
  }, [scope, attributeKey, retryVersion]);
  const change = (values: Record<string, string>) =>
    setPreferences((previous) => ({ ...previous, [preference]: values }));
  const rotate = () => {
    const facing = template?.attributes.facingAttribute;
    if (!facing) return;
    const value =
      attributes[facing] ||
      template.children.find(
        (n) => n.tag === "attribute" && n.attributes.name === facing,
      )?.attributes.value ||
      "east";
    const directions = ["east", "south", "west", "north"];
    change({
      ...attributes,
      [facing]: directions[(directions.indexOf(value) + 1) % 4],
    });
  };
  return {
    tool,
    template: tool ? template : null,
    attributes,
    loading: Boolean(
      tool &&
      (status.scope !== scope ||
        status.attributes !== attributeKey ||
        status.loading),
    ),
    error:
      status.scope === scope && status.attributes === attributeKey
        ? status.error
        : "",
    repeat,
    setRepeat,
    change,
    rotate,
    retry: () => setRetryVersion((value) => value + 1),
  };
}
