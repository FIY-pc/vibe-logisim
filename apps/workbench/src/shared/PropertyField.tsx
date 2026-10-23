import { useEffect, useId, useRef, useState } from "react";
import { optionLabels, propertyLabels } from "../editor/componentLabels";
import type { XmlNode } from "./types";
import "../editor/inspector.css";
import { Select } from "./Select";

interface Props {
  field: XmlNode;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
  title?: string;
  onCommit: (value: string) => Promise<void> | void;
  onCancel?: () => void;
}

/** Text commits with Enter; choices commit immediately. Escape restores the native value. */
export function PropertyField({
  field,
  disabled,
  error: externalError,
  placeholder,
  title,
  onCommit,
  onCancel,
}: Props) {
  const name = field.attributes.name;
  const label = propertyLabels[name] || field.attributes.label || name;
  const committed = field.attributes.value || "";
  const [value, setValue] = useState(committed);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const live = useRef(true);
  const errorId = useId();
  useEffect(() => {
    setValue(committed);
    setError("");
  }, [committed]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const readOnly = field.attributes.editable !== "true";
  const options = field.children.filter((n) => n.tag === "option");
  const multiline = name === "contents" || committed.includes("\n");
  const submit = async (next = value) => {
    if (readOnly || disabled || pendingRef.current || next === committed)
      return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      await onCommit(next);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pendingRef.current = false;
      if (live.current) setPending(false);
    }
  };
  const problem = error || externalError;
  const common = {
    "aria-label": label,
    "aria-invalid": Boolean(problem),
    "aria-describedby": problem ? errorId : undefined,
    disabled: Boolean(readOnly || disabled || pending),
    value,
    title: readOnly
      ? "此属性暂不支持在这里编辑"
      : title ||
        (options.length
          ? label
          : multiline
            ? "Ctrl+Enter 提交 · Escape 取消"
            : "Enter 提交 · Escape 取消"),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (multiline && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setValue(committed);
        setError("");
        onCancel?.();
        (e.currentTarget as HTMLElement).blur();
      }
    },
  };
  return (
    <form
      className="property-field"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-busy={pending}
    >
      <label>
        <span>{label}</span>
        {options.length ? (
          <Select
            label={label}
            title={common.title}
            disabled={common.disabled}
            value={value}
            options={options.map((option) => ({
              value: option.attributes.value,
              label:
                optionLabels[option.attributes.label] ||
                option.attributes.label ||
                option.attributes.value,
            }))}
            onChange={(next) => {
              setValue(next);
              void submit(next);
            }}
          />
        ) : multiline ? (
          <textarea
            {...common}
            rows={5}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            {...common}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </label>
      {problem && (
        <span id={errorId} className="property-error" role="alert">
          {problem}
        </span>
      )}
    </form>
  );
}
