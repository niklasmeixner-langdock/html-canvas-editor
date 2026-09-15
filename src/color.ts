export function cssColorToHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, a, b, c] = trimmed;
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  const match = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return "#ffffff";
  return `#${[match[1], match[2], match[3]]
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Alpha channel of a computed CSS colour (1 when opaque or unknown). */
export function colorAlpha(value: string): number {
  const match = value.trim().match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (!match) return 1;
  return match[1] == null ? 1 : Math.max(0, Math.min(1, Number(match[1])));
}

/**
 * Keep a computed colour usable as a CSS `background`/`color` value without
 * losing alpha. Opaque colours become hex (nicer in the props panel);
 * translucent ones stay as rgba().
 */
export function cssColorValue(value: string): string {
  return colorAlpha(value) < 1 ? value.trim() : cssColorToHex(value);
}

export function isTransparent(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return (
    !trimmed ||
    trimmed === "transparent" ||
    trimmed === "rgba(0, 0, 0, 0)" ||
    trimmed === "rgba(0,0,0,0)" ||
    colorAlpha(trimmed) === 0
  );
}
