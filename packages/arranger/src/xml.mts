// The subset of an ElementTree document the engine needs: parse a .circ
// file the way expat does (line ends and attribute whitespace normalised,
// comments and processing instructions dropped, attribute order kept),
// serialise one element back exactly as ElementTree writes it, and find the
// source span of one <circuit> so the rest of the file stays byte for byte.

export class XmlElement {
  tag: string;
  attrib: Map<string, string>;
  text: string | null = null;
  tail: string | null = null;
  children: XmlElement[] = [];

  constructor(tag: string, attrib?: Iterable<[string, string]>) {
    this.tag = tag;
    this.attrib = new Map(attrib ?? []);
  }

  get(name: string): string | null;
  get(name: string, fallback: string): string;
  get(name: string, fallback: string | null = null): string | null {
    const value = this.attrib.get(name);
    return value === undefined ? fallback : value;
  }

  set(name: string, value: string): void {
    this.attrib.set(name, value);
  }

  findall(path: string): XmlElement[] {
    const { tag, attr, value } = parsePath(path);
    return this.children.filter(
      (c) => c.tag === tag && (attr === null || c.attrib.get(attr) === value),
    );
  }

  find(path: string): XmlElement | null {
    const { tag, attr, value } = parsePath(path);
    return (
      this.children.find(
        (c) => c.tag === tag && (attr === null || c.attrib.get(attr) === value),
      ) ?? null
    );
  }

  *iter(tag?: string): Generator<XmlElement> {
    if (tag === undefined || this.tag === tag) yield this;
    for (const child of this.children) yield* child.iter(tag);
  }

  append(child: XmlElement): void {
    this.children.push(child);
  }

  remove(child: XmlElement): void {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("list.remove(x): x not in list");
    this.children.splice(index, 1);
  }
}

const pathCache = new Map<
  string,
  { tag: string; attr: string | null; value: string | null }
>();

function parsePath(path: string) {
  let parsed = pathCache.get(path);
  if (!parsed) {
    const m = /^([^[\]]+)(?:\[@([^=]+)='([^']*)'\])?$/.exec(path);
    if (!m) throw new Error("unsupported path " + path);
    parsed = { tag: m[1], attr: m[2] ?? null, value: m[3] ?? null };
    pathCache.set(path, parsed);
  }
  return parsed;
}

export function subElement(
  parent: XmlElement,
  tag: string,
  attrib: Record<string, string>,
): XmlElement {
  const element = new XmlElement(tag, Object.entries(attrib));
  parent.append(element);
  return element;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&\s]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) throw new XmlParseError("not well-formed");
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#"))
      return String.fromCodePoint(parseInt(name.slice(1), 10));
    const value = ENTITIES[name];
    if (value === undefined)
      throw new XmlParseError("undefined entity &" + name + ";");
    return value;
  });
}

function normaliseText(raw: string): string {
  return decodeEntities(raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw);
}

function normaliseAttribute(raw: string): string {
  return decodeEntities(raw.replace(/\r\n|[\r\n\t]/g, " "));
}

interface ScanHandlers {
  start(tag: string, attrs: [string, string][], at: number): void;
  end(tag: string, at: number): void;
  data(text: string): void;
}

const NAME_END = /[\s/>=]/;

// One pass over the document; `at` is the index of the tag's "<".
function scan(source: string, handlers: ScanHandlers): void {
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = source.length;
  while (pos < n) {
    const lt = source.indexOf("<", pos);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > pos) handlers.data(normaliseText(source.slice(pos, textEnd)));
    if (lt < 0) break;
    if (source.startsWith("<?", lt)) {
      const close = source.indexOf("?>", lt + 2);
      if (close < 0) throw new XmlParseError("unclosed processing instruction");
      pos = close + 2;
    } else if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      if (close < 0) throw new XmlParseError("unclosed comment");
      pos = close + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const close = source.indexOf("]]>", lt + 9);
      if (close < 0) throw new XmlParseError("unclosed CDATA section");
      const raw = source.slice(lt + 9, close);
      if (raw) handlers.data(raw.replace(/\r\n?/g, "\n"));
      pos = close + 3;
    } else if (source.startsWith("<!", lt)) {
      let depth = 0;
      let i = lt + 2;
      for (; i < n; i++) {
        const ch = source[i];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
      }
      pos = i + 1;
    } else if (source.startsWith("</", lt)) {
      const close = source.indexOf(">", lt + 2);
      if (close < 0) throw new XmlParseError("unclosed end tag");
      handlers.end(source.slice(lt + 2, close).trim(), lt);
      pos = close + 1;
    } else {
      let i = lt + 1;
      while (i < n && !NAME_END.test(source[i])) i++;
      const tag = source.slice(lt + 1, i);
      if (!tag) throw new XmlParseError("not well-formed (invalid token)");
      const attrs: [string, string][] = [];
      let empty = false;
      for (;;) {
        while (i < n && /\s/.test(source[i])) i++;
        if (i >= n) throw new XmlParseError("unclosed start tag");
        if (source[i] === ">") {
          i++;
          break;
        }
        if (source.startsWith("/>", i)) {
          empty = true;
          i += 2;
          break;
        }
        const nameStart = i;
        while (i < n && !NAME_END.test(source[i])) i++;
        const name = source.slice(nameStart, i);
        while (i < n && /\s/.test(source[i])) i++;
        if (source[i] !== "=")
          throw new XmlParseError("not well-formed (invalid token)");
        i++;
        while (i < n && /\s/.test(source[i])) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== "'")
          throw new XmlParseError("not well-formed (invalid token)");
        const close = source.indexOf(quote, i + 1);
        if (close < 0) throw new XmlParseError("unclosed attribute value");
        attrs.push([name, normaliseAttribute(source.slice(i + 1, close))]);
        i = close + 1;
      }
      handlers.start(tag, attrs, lt);
      if (empty) handlers.end(tag, lt);
      pos = i;
    }
  }
}

// ET.fromstring: the root element (text before it and comments are dropped).
export function parseXml(source: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let last: XmlElement | null = null;
  let tail = false;
  let data: string[] = [];
  const flush = () => {
    if (data.length) {
      if (last !== null) {
        const text = data.join("");
        if (tail) last.tail = text;
        else last.text = text;
      }
      data = [];
    }
  };
  scan(source, {
    start(tag, attrs) {
      flush();
      const element = new XmlElement(tag, attrs);
      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root === null) root = element;
      else throw new XmlParseError("junk after document element");
      stack.push(element);
      last = element;
      tail = false;
    },
    end(tag) {
      flush();
      const element = stack.pop();
      if (!element || element.tag !== tag)
        throw new XmlParseError("mismatched tag");
      last = element;
      tail = true;
    },
    data(text) {
      data.push(text);
    },
  });
  flush();
  if (root === null || stack.length)
    throw new XmlParseError("no element found");
  return root;
}

// [start, end) of <circuit name=...>...</circuit> (a direct child of the
// root) in the source string, or null when it is absent or an empty element.
export function circuitSpan(
  source: string,
  name: string,
): [number, number] | null {
  let depth = 0;
  let start = -1;
  let end = -1;
  scan(source, {
    start(tag, attrs, at) {
      depth++;
      if (tag === "circuit" && depth === 2 && start < 0) {
        const value = attrs.find(([k]) => k === "name")?.[1];
        if (value === name) start = at;
      }
    },
    end(tag, at) {
      if (tag === "circuit" && depth === 2 && start >= 0 && end < 0) end = at;
      depth--;
    },
    data() {},
  });
  if (end < 0 || end === start) return null;
  return [start, source.indexOf(">", end) + 1];
}

function escapeCdata(text: string): string {
  if (text.includes("&")) text = text.replaceAll("&", "&amp;");
  if (text.includes("<")) text = text.replaceAll("<", "&lt;");
  if (text.includes(">")) text = text.replaceAll(">", "&gt;");
  return text;
}

function escapeAttrib(text: string): string {
  if (text.includes("&")) text = text.replaceAll("&", "&amp;");
  if (text.includes("<")) text = text.replaceAll("<", "&lt;");
  if (text.includes(">")) text = text.replaceAll(">", "&gt;");
  if (text.includes('"')) text = text.replaceAll('"', "&quot;");
  if (text.includes("\r")) text = text.replaceAll("\r", "&#13;");
  if (text.includes("\n")) text = text.replaceAll("\n", "&#10;");
  if (text.includes("\t")) text = text.replaceAll("\t", "&#09;");
  return text;
}

function write(element: XmlElement, out: string[]): void {
  out.push("<" + element.tag);
  for (const [k, v] of element.attrib) out.push(` ${k}="${escapeAttrib(v)}"`);
  if (element.text || element.children.length) {
    out.push(">");
    if (element.text) out.push(escapeCdata(element.text));
    for (const child of element.children) write(child, out);
    out.push("</" + element.tag + ">");
  } else {
    out.push(" />");
  }
  if (element.tail) out.push(escapeCdata(element.tail));
}

// ET.tostring(element, encoding="unicode"), or with `ascii` the default
// us-ascii form where every other character is a numeric reference.
export function serialize(element: XmlElement, ascii = false): string {
  const out: string[] = [];
  write(element, out);
  const text = out.join("");
  if (!ascii) return text;
  return text.replace(/[^\x00-\x7f]/gu, (ch) => `&#${ch.codePointAt(0)};`);
}
