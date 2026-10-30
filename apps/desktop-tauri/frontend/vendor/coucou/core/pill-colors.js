// Source: reference/coucou windows/src/core/pill-colors.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
const PILL_PALETTE = [
  "#F5F6F8",
  "#F4505E",
  "#F29B38",
  "#FACC15",
  "#4ADE80",
  "#2DD4BF",
  "#38BDF8",
  "#818CF8",
  "#C084FC",
  "#E879F9"
];
function normalizeHex(raw) {
  if (typeof raw !== "string") return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
function parsePillColors(raw) {
  const out = {};
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    const hex = normalizeHex(value);
    if (id && hex) out[id] = hex;
  }
  return out;
}
function pillColor(id, catalogColor, colors) {
  return parsePillColors(colors)[id] ?? catalogColor;
}
function withPillColor(colors, id, hex, catalogColor) {
  const next = parsePillColors(colors);
  const picked = normalizeHex(hex);
  if (picked && picked !== normalizeHex(catalogColor)) next[id] = picked;
  else delete next[id];
  return next;
}
export {
  PILL_PALETTE,
  normalizeHex,
  parsePillColors,
  pillColor,
  withPillColor
};
