/** Executable limits of the tool catalog, checked before a handler runs. */
import { isDeepStrictEqual } from "node:util";
import { CircuitToolError } from "./errors.mts";

type Schema = Record<string, any>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  object,
  array: Array.isArray,
  boolean: (value) => typeof value === "boolean",
  integer: (value) => number(value) && Number.isInteger(value),
  number,
};
const typed = (value: unknown, expected: unknown) =>
  typeof expected !== "string" || !TYPES[expected] || TYPES[expected](value);
const invalid = (
  message: string,
  { hint, context }: { hint?: string; context?: Record<string, unknown> } = {},
) => new CircuitToolError("INVALID_ARGUMENT", message, { hint, context });
const length = (value: string) => [...value].length;

/** Top-level checks name the argument; nested checks name its JSON path. */
export function validateArguments(
  schema: Schema,
  args: Record<string, unknown>,
) {
  const properties: Schema = object(schema.properties) ? schema.properties : {};
  const missing = (schema.required || []).filter(
    (name: string) => !Object.hasOwn(args, name),
  );
  if (missing.length)
    throw invalid(`工具缺少必填参数: ${missing.join(", ")}`, {
      hint: "补齐 required 中的参数后重新调用。",
      context: { required: missing },
    });
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args)
      .filter((name) => !Object.hasOwn(properties, name))
      .sort();
    if (unknown.length)
      throw invalid(`工具包含未声明的参数: ${unknown.join(", ")}`, {
        hint: "使用当前工具声明中的参数名。",
        context: { allowed: Object.keys(properties) },
      });
  }
  for (const [name, value] of Object.entries(args)) {
    const property: Schema = object(properties[name]) ? properties[name] : {};
    if (!typed(value, property.type))
      throw invalid(`工具参数类型错误: ${name} 应为 ${property.type}`);
    if (
      Array.isArray(property.enum) &&
      !property.enum.some((item: unknown) => isDeepStrictEqual(item, value))
    )
      throw invalid(`工具参数取值无效: ${name}`, {
        context: { allowed: property.enum },
      });
  }
  validateValue(args, schema, "arguments");
}

function validateValue(value: unknown, schema: Schema, path: string) {
  if (!typed(value, schema.type))
    throw invalid(`参数 ${path} 类型错误，应为 ${schema.type}`, {
      hint: "按照当前工具目录中的 inputSchema 修正参数。",
      context: { path, expected: schema.type },
    });
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item: unknown) => isDeepStrictEqual(item, value))
  )
    throw invalid(`参数 ${path} 取值无效`, {
      hint: "使用 inputSchema.enum 中的值。",
      context: { path, allowed: schema.enum },
    });
  if (number(value)) {
    if (number(schema.minimum) && value < schema.minimum)
      throw invalid(`参数 ${path} 不能小于 ${schema.minimum}`, {
        hint: `将 ${path} 调整到不小于 ${schema.minimum}。`,
        context: { path, minimum: schema.minimum },
      });
    if (number(schema.maximum) && value > schema.maximum)
      throw invalid(`参数 ${path} 不能大于 ${schema.maximum}`, {
        hint: `将 ${path} 调整到不大于 ${schema.maximum}。`,
        context: { path, maximum: schema.maximum },
      });
  }
  if (typeof value === "string") {
    if (number(schema.minLength) && length(value) < schema.minLength)
      throw invalid(`参数 ${path} 长度不足`, {
        context: { path, minLength: schema.minLength },
      });
    if (number(schema.maxLength) && length(value) > schema.maxLength)
      throw invalid(`参数 ${path} 长度超过上限`, {
        context: { path, maxLength: schema.maxLength },
      });
  }
  if (Array.isArray(value)) {
    if (number(schema.minItems) && value.length < schema.minItems)
      throw invalid(`参数 ${path} 至少需要 ${schema.minItems} 项`, {
        context: { path, minItems: schema.minItems },
      });
    if (number(schema.maxItems) && value.length > schema.maxItems)
      throw invalid(`参数 ${path} 最多允许 ${schema.maxItems} 项`, {
        hint: `将 ${path} 的项目数量减少到 ${schema.maxItems} 项以内。`,
        context: { path, maxItems: schema.maxItems },
      });
    if (object(schema.items))
      value.forEach((item, index) =>
        validateValue(item, schema.items, `${path}[${index}]`),
      );
  }
  if (object(value)) {
    const count = Object.keys(value).length;
    if (number(schema.minProperties) && count < schema.minProperties)
      throw invalid(`参数 ${path} 至少需要 ${schema.minProperties} 个字段`, {
        hint: "按照 inputSchema.minProperties 补齐对象字段。",
        context: { path, minProperties: schema.minProperties },
      });
    if (number(schema.maxProperties) && count > schema.maxProperties)
      throw invalid(`参数 ${path} 最多允许 ${schema.maxProperties} 个字段`, {
        hint: `将 ${path} 的字段数量减少到 ${schema.maxProperties} 个以内。`,
        context: { path, maxProperties: schema.maxProperties },
      });
    const missing = (schema.required || []).filter(
      (name: string) => !Object.hasOwn(value, name),
    );
    if (missing.length)
      throw invalid(`参数 ${path} 缺少必填字段: ${missing.join(", ")}`, {
        hint: "补齐 inputSchema.required 中的字段。",
        context: { path, required: missing },
      });
    const properties: Schema = object(schema.properties)
      ? schema.properties
      : {};
    const additional = schema.additionalProperties ?? true;
    const unknown =
      additional === false
        ? Object.keys(value)
            .filter((name) => !Object.hasOwn(properties, name))
            .sort()
        : [];
    if (unknown.length)
      throw invalid(`参数 ${path} 包含未声明字段: ${unknown.join(", ")}`, {
        hint: "只使用当前工具目录 inputSchema.properties 中的字段。",
        context: { path, allowed: Object.keys(properties) },
      });
    for (const [name, item] of Object.entries(value)) {
      const child = Object.hasOwn(properties, name)
        ? properties[name]
        : object(additional)
          ? additional
          : null;
      if (object(child)) validateValue(item, child, `${path}.${name}`);
    }
  }
}
