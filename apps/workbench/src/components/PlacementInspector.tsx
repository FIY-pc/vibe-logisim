import { useEffect, useRef, useState } from "react";
import type { XmlNode } from "../lib/types";
import type { PlacementState } from "../lib/usePlacement";
import { isAppearanceProperty } from "../lib/componentLabels";
import { PropertyField } from "./PropertyField";

export function PlacementInspector({
  placement,
}: {
  placement: PlacementState;
}) {
  const [fields, setFields] = useState<XmlNode[]>([]);
  const [lastField, setLastField] = useState("");
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const accepted = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!placement.template) return;
    setFields(
      placement.template.children
        .filter(
          (n) => n.tag === "attribute" && n.attributes.editable === "true",
        )
        .sort(
          (a, b) =>
            Number(b.attributes.name === "label") -
            Number(a.attributes.name === "label"),
        ),
    );
    accepted.current = { ...placement.attributes };
  }, [placement.template]);
  const confirmedValues = JSON.stringify(
    fields.map((field) => [field.attributes.name, field.attributes.value]),
  );
  const renderField = (field: XmlNode) => (
    <PropertyField
      key={`${field.attributes.name}:${confirmedValues}`}
      field={field}
      disabled={placement.loading}
      error={lastField === field.attributes.name ? placement.error : undefined}
      onCommit={(value) => {
        setLastField(field.attributes.name);
        placement.change({
          ...accepted.current,
          [field.attributes.name]: value,
        });
      }}
      onCancel={() => {
        if (placement.error) placement.change(accepted.current);
      }}
    />
  );
  const appearance = fields.filter((f) =>
    isAppearanceProperty(f.attributes.name),
  );
  return (
    <div className="inspector placement-inspector">
      <div className="panel-heading">
        {placement.tool?.label}
        <span>新元件属性</span>
      </div>
      <div className="inspector-content">
        {placement.loading && (
          <p className="muted" role="status">
            正在读取属性…
          </p>
        )}
        {placement.error && !lastField && (
          <p className="property-error" role="alert">
            {placement.error}
            {placement.retry && (
              <button onClick={placement.retry}>重新读取</button>
            )}
          </p>
        )}
        {fields
          .filter((f) => !isAppearanceProperty(f.attributes.name))
          .map(renderField)}
        {appearance.length > 0 && (
          <details
            className="appearance-properties"
            open={appearanceOpen}
            onToggle={(e) => setAppearanceOpen(e.currentTarget.open)}
          >
            <summary>外观</summary>
            {appearance.map(renderField)}
          </details>
        )}
      </div>
    </div>
  );
}
