export function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

export function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
  }

export function shortRevision(revision) {
    const raw = revision && typeof revision === "object"
      ? firstDefined(revision.sha256, revision.digest, revision.id, revision.revision)
      : revision;
    if (!raw) return "未冻结";
    const text = String(raw).replace(/^sha256:/, "");
    return text.length > 13 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
  }

export function revisionValue(raw) {
    if (!raw) return null;
    if (typeof raw === "string") return raw;
    return firstDefined(raw.sha256, raw.digest, raw.id, raw.revision, raw.contentSha256);
  }

export function responseRevision(payload) {
    return revisionValue(firstDefined(payload?.revision, payload?.revisionId, payload?.artifactSha256));
  }

export function displayName(value) {
    if (typeof value === "string") return value;
    return firstDefined(value?.name, value?.circuit, value?.label, value?.id, "未命名电路");
  }

export function statusErrorMessage(payload, fallback) {
    const nested = payload?.error;
    return firstDefined(
      payload?.message,
      typeof nested === "object" ? nested.message : nested,
      payload?.detail,
      typeof nested === "object" ? nested.detail : null,
      fallback,
    );
  }

export function normalizePoint(value) {
    if (!value) return null;
    if (Array.isArray(value) && value.length >= 2) return { x: Number(value[0]), y: Number(value[1]) };
    if (typeof value === "string") {
      const match = value.match(/\(?\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)\s*\)?/);
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    }
    const x = Number(firstDefined(value.x, value.left, value[0]));
    const y = Number(firstDefined(value.y, value.top, value[1]));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

export function normalizeBounds(value, fallbackPoint = null) {
    if (Array.isArray(value) && value.length >= 4) {
      return { x: Number(value[0]), y: Number(value[1]), width: Number(value[2]), height: Number(value[3]) };
    }
    if (value && typeof value === "object") {
      const x = Number(firstDefined(value.x, value.left, value.minX));
      const y = Number(firstDefined(value.y, value.top, value.minY));
      let width = Number(firstDefined(value.width, value.w));
      let height = Number(firstDefined(value.height, value.h));
      if (!Number.isFinite(width) && Number.isFinite(Number(value.maxX))) width = Number(value.maxX) - x;
      if (!Number.isFinite(height) && Number.isFinite(Number(value.maxY))) height = Number(value.maxY) - y;
      if ([x, y, width, height].every(Number.isFinite)) return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
    }
    const point = fallbackPoint || { x: 0, y: 0 };
    return { x: point.x - 20, y: point.y - 15, width: 40, height: 30 };
  }

export function componentId(component, index) {
    return String(firstDefined(component.componentId, component.id, component.objectId, component.ref, `component-${index}`));
  }

export function netId(net, index) {
    return String(firstDefined(net.netId, net.id, net.objectId, `net-${index}`));
  }

export function wireId(wire, index) {
    return String(firstDefined(wire.wireId, wire.id, wire.objectId, `wire-${index}`));
  }

export function componentPoint(component) {
    return normalizePoint(firstDefined(component.location, component.at, component.position)) ||
      normalizePoint(component) || { x: 0, y: 0 };
  }

export function wirePoints(wire) {
    const points = asArray(firstDefined(wire.points, wire.path, wire.vertices)).map(normalizePoint).filter(Boolean);
    if (points.length >= 2) return points;
    const from = normalizePoint(firstDefined(wire.from, wire.start, wire.a));
    const to = normalizePoint(firstDefined(wire.to, wire.end, wire.b));
    return from && to ? [from, to] : [];
  }

export function rectanglesIntersect(a, b) {
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
  }

export function pointInRectangle(point, rect) {
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  }

export function formatSignal(port) {
    if (!port) return "—";
    if (port.value === null) {
      const bits = port.bits?.replaceAll(" ", "") || "";
      if (/^[xX?]+$/.test(bits)) return `未知 · ${port.width}位`;
      if (/^[Ee]+$/.test(bits)) return `错误 · ${port.width}位`;
      return bits || "未知";
    }
    return port.width === 1 ? String(port.value) : `0x${port.value.toString(16).toUpperCase().padStart(Math.ceil(port.width / 4), "0")}`;
  }

export function formatInput(port) {
    return port?.value === null ? `0b${(port.bits || "").replaceAll(" ", "").replace(/[?X]/g, "x")}` : formatSignal(port);
  }
