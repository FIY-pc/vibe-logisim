/** User-facing numbers are converted to native bits; this never edits circuit attributes. */
export function inputBits(raw: string, width: number, tristate: boolean) {
  const text = raw.trim().toLowerCase().replaceAll("_", "");
  if (!Number.isInteger(width) || width < 1 || width > 4096)
    throw new Error("无法确定输入位宽，请重新读取元件属性。");
  if (text.includes("x") && !text.startsWith("0x")) {
    let bits = text.replace(/^0b/, "");
    if (bits === "x") bits = bits.repeat(width);
    if (bits.length !== width || !/^[01x]+$/.test(bits))
      throw new Error(
        `未知位输入须包含 ${width} 位二进制数，使用 x 表示未知。`,
      );
    if (!tristate) throw new Error("请先开启三态，再输入未知位。");
    return bits;
  }
  if (!/^(?:\+?[0-9]+|0x[0-9a-f]+|0b[01]+)$/.test(text))
    throw new Error("请输入十进制数、0x 十六进制数或 0b 二进制数。");
  const value = BigInt(text);
  if (value >= 1n << BigInt(width))
    throw new Error(
      `输入值超出 ${width} 位范围（0–${(1n << BigInt(width)) - 1n}）。`,
    );
  return value.toString(2).padStart(width, "0");
}

export function inputDisplay(rawBits: string | undefined) {
  if (!rawBits) return "";
  const bits = rawBits.replaceAll(" ", "").replace(/[?X]/g, "x");
  if (!/^[01]+$/.test(bits)) return `0b${bits}`;
  if (bits.length === 1) return bits;
  return `0x${BigInt(`0b${bits}`)
    .toString(16)
    .toUpperCase()
    .padStart(Math.ceil(bits.length / 4), "0")}`;
}
