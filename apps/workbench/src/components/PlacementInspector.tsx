import { useEffect, useState } from "react";
import type { XmlNode } from "../lib/types";
import type { PlacementState } from "../lib/usePlacement";
export function PlacementInspector({
  placement,
}: {
  placement: PlacementState;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<XmlNode[]>([]);
  useEffect(() => {
    if (!placement.template) return;
    const previousValues = Object.fromEntries(
      fields.map((field) => [field.attributes.name, field.attributes.value]),
    );
    const nextFields = placement.template.children.filter(
      (n) => n.tag === "attribute" && n.attributes.editable === "true",
    );
    setFields(nextFields);
    setDraft((previous) =>
      Object.fromEntries(
        nextFields.map((n) => {
          const key = n.attributes.name;
          const value = n.attributes.value;
          const pending =
            key in previous && previous[key] !== previousValues[key];
          return [
            key,
            pending && value === previousValues[key] ? previous[key] : value,
          ];
        }),
      ),
    );
  }, [placement.template]);
  const values = Object.fromEntries(
    fields
      .filter((f) => draft[f.attributes.name] !== f.attributes.value)
      .map((f) => [f.attributes.name, draft[f.attributes.name]]),
  );
  return (
    <div className="inspector placement-inspector">
      <div className="panel-heading">
        {placement.tool?.label}
        <span>新元件属性</span>
      </div>
      {placement.loading && (
        <p className="muted" role="status">
          正在读取属性…
        </p>
      )}
      {placement.error && (
        <p className="dialog-error" role="alert">
          {placement.error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          placement.change({ ...placement.attributes, ...values });
        }}
      >
        {fields.map((field) => {
          const key = field.attributes.name,
            options = field.children.filter((n) => n.tag === "option");
          return (
            <label key={key}>
              <span>{field.attributes.label || key}</span>
              {options.length ? (
                <select
                  aria-label={field.attributes.label || key}
                  disabled={placement.loading}
                  value={draft[key] || ""}
                  onChange={(e) => {
                    setDraft({ ...draft, [key]: e.target.value });
                    placement.change({
                      ...placement.attributes,
                      ...values,
                      [key]: e.target.value,
                    });
                  }}
                >
                  {options.map((option) => (
                    <option
                      key={option.attributes.value}
                      value={option.attributes.value}
                    >
                      {option.attributes.label || option.attributes.value}
                    </option>
                  ))}
                </select>
              ) : key === "contents" || (draft[key] || "").includes("\n") ? (
                <textarea
                  aria-label={field.attributes.label || key}
                  disabled={placement.loading}
                  value={draft[key] || ""}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                />
              ) : (
                <input
                  aria-label={field.attributes.label || key}
                  disabled={placement.loading}
                  value={draft[key] || ""}
                  onChange={(e) =>
                    setDraft({ ...draft, [key]: e.target.value })
                  }
                />
              )}
            </label>
          );
        })}
        <button
          className="small-button"
          type="submit"
          disabled={placement.loading || !Object.keys(values).length}
        >
          应用
        </button>
      </form>
    </div>
  );
}
