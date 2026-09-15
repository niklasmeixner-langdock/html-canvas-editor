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

export function isTransparent(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return (
    !trimmed ||
    trimmed === "transparent" ||
    trimmed === "rgba(0, 0, 0, 0)" ||
    trimmed === "rgba(0,0,0,0)"
  );
}
