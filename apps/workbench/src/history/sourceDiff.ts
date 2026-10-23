export interface SourceLine {
  before?: string;
  after?: string;
  beforeNumber?: number;
  afterNumber?: number;
  changed: boolean;
}
/** Exact source lines, bounded work even for large/minified generated circuits. */
export function sourceDiff(original: string, revised: string): SourceLine[] {
  const a = original.split("\n"),
    b = revised.split("\n");
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix),
    right = b.slice(prefix, b.length - suffix);
  const result: SourceLine[] = a.slice(0, prefix).map((line, i) => ({
    before: line,
    after: line,
    beforeNumber: i + 1,
    afterNumber: i + 1,
    changed: false,
  }));
  let ai = prefix + 1,
    bi = prefix + 1;
  const add = (
    before: string | undefined,
    after: string | undefined,
    changed = true,
  ) =>
    result.push({
      before,
      after,
      beforeNumber: before === undefined ? undefined : ai++,
      afterNumber: after === undefined ? undefined : bi++,
      changed,
    });
  if (left.length * right.length <= 1_000_000) {
    const width = right.length + 1,
      matrix = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--) {
        matrix[i * width + j] =
          left[i] === right[j]
            ? 1 + matrix[(i + 1) * width + j + 1]
            : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
      }
    let i = 0,
      j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j])
        add(left[i++], right[j++], false);
      else if (
        i < left.length &&
        (j === right.length ||
          matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])
      )
        add(left[i++], undefined);
      else add(undefined, right[j++]);
    }
  } else {
    for (let i = 0; i < Math.max(left.length, right.length); i++)
      add(left[i], right[i]);
  }
  for (let i = 0; i < suffix; i++)
    add(a[a.length - suffix + i], b[b.length - suffix + i], false);
  return result;
}
