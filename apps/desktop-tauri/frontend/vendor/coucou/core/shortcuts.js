// Source: reference/coucou windows/src/core/shortcuts.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { N_ } from "../i18n/i18n.js";
const SHORTCUT_TEXT = {
  toggleIsland: N_("Open or close the island"),
  openChat: N_("Open the chat"),
  goToAlert: N_("Go to the waiting permission or question"),
  jumpToTerminal: N_("Open the terminal"),
  attachFrontWindow: N_("Attach the front window to the chat"),
  nextPill: N_("Next pill"),
  prevPill: N_("Previous pill"),
  // Abito adaptation: reserved character name replaced; action IDs stay unchanged.
  muteToggle: N_("Mute or unmute Koda"),
  desktopToggle: N_("Send Koda to the desktop"),
  wardrobeToggle: N_("Open the wardrobe"),
  island: {
    nextPrev: N_("Next or previous pill"),
    byNumber: N_("Go to pill 1 to 9"),
    navItems: N_("Navigate list items"),
    open: N_("Open selected item"),
    diff: N_("Open / close current diff"),
    send: N_("Send the message"),
    newChat: N_("Start a new chat"),
    settings: N_("Open Settings"),
    pin: N_("Keep the island open"),
    close: N_("Close the island")
  }
};
const def = (id, defaultKeys, enabledByDefault, ported) => ({ id, defaultKeys, enabledByDefault, ported });
const SHORTCUTS = [
  def("toggleIsland", "Ctrl+Alt+N", false, true),
  def("openChat", "Ctrl+Alt+Space", true, true),
  def("goToAlert", "Ctrl+Alt+A", true, true),
  def("jumpToTerminal", "Ctrl+Alt+T", true, true),
  def("attachFrontWindow", "Ctrl+Alt+F", true, false),
  def("nextPill", "Ctrl+Alt+Right", true, true),
  def("prevPill", "Ctrl+Alt+Left", true, true),
  def("muteToggle", "Ctrl+Alt+S", true, true),
  def("desktopToggle", "Ctrl+Alt+D", true, true),
  def("wardrobeToggle", "Ctrl+Alt+G", true, true)
];
function effective(d, stored) {
  const own = stored?.[d.id];
  return own ? { keys: own.keys, enabled: own.enabled } : { keys: d.defaultKeys, enabled: d.enabledByDefault };
}
const PUNCTUATION = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "="
};
const NAMED = [
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right"
];
const KEY_NAMES = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...NAMED,
  ...Object.keys(PUNCTUATION)
];
const KEY_ALIASES = {
  ARROWUP: "Up",
  ARROWDOWN: "Down",
  ARROWLEFT: "Left",
  ARROWRIGHT: "Right",
  RETURN: "Enter",
  ESC: "Escape",
  DEL: "Delete",
  " ": "Space",
  ...Object.fromEntries(Object.entries(PUNCTUATION).map(([name, ch]) => [ch, name]))
};
function canonicalKey(token) {
  const up = token.toUpperCase();
  if (KEY_ALIASES[token]) return KEY_ALIASES[token];
  if (KEY_ALIASES[up]) return KEY_ALIASES[up];
  if (/^KEY[A-Z]$/.test(up)) return up.slice(3);
  if (/^DIGIT[0-9]$/.test(up)) return up.slice(5);
  return KEY_NAMES.find((k) => k.toUpperCase() === up) ?? null;
}
function parseKeys(text) {
  if (!text.trim()) return null;
  const tokens = text.split("+").map((t) => t.trim());
  if (tokens.some((t) => !t)) return null;
  const combo = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const [i, token] of tokens.entries()) {
    const last = i === tokens.length - 1;
    switch (token.toUpperCase()) {
      case "CTRL":
      case "CONTROL":
      case "COMMANDORCONTROL":
      case "CMDORCTRL":
        if (last) return null;
        combo.ctrl = true;
        continue;
      case "ALT":
      case "OPTION":
        if (last) return null;
        combo.alt = true;
        continue;
      case "SHIFT":
        if (last) return null;
        combo.shift = true;
        continue;
      case "SUPER":
      case "META":
      case "WIN":
      case "CMD":
      case "COMMAND":
        if (last) return null;
        combo.meta = true;
        continue;
    }
    if (!last) return null;
    const key = canonicalKey(token);
    if (!key || key === "Escape") return null;
    combo.key = key;
  }
  if (!combo.key || !(combo.ctrl || combo.alt || combo.meta)) return null;
  return combo;
}
function formatKeys(c) {
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Super");
  parts.push(c.key);
  return parts.join("+");
}
function normalizeKeys(text) {
  const c = parseKeys(text);
  return c ? formatKeys(c) : null;
}
const KEY_GLYPHS = { Up: "↑", Down: "↓", Left: "←", Right: "→", ...PUNCTUATION };
function displayKeys(text) {
  const c = parseKeys(text);
  if (!c) return text.trim() ? text : "—";
  const parts = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Win");
  parts.push(KEY_GLYPHS[c.key] ?? c.key);
  return parts.join("+");
}
const MODIFIER_KEYS = /* @__PURE__ */ new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS", "Super", "Hyper"]);
function pressedKey(e) {
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) return e.code;
  if (NAMED.includes(e.code) || e.code in PUNCTUATION) return e.code;
  if (e.code === "NumpadEnter") return "Enter";
  return null;
}
function recordPress(e) {
  if (MODIFIER_KEYS.has(e.key)) return { kind: "pending" };
  const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  if (e.key === "Escape" && bare) return { kind: "cancel" };
  if ((e.key === "Backspace" || e.key === "Delete") && bare) return { kind: "clear" };
  const key = pressedKey(e);
  if (!key) return { kind: "unsupported" };
  if (!(e.ctrlKey || e.altKey || e.metaKey)) return { kind: "needsModifier" };
  const keys = formatKeys({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key });
  if (e.ctrlKey && e.altKey && !e.metaKey) {
    if (e.key === "Dead") return { kind: "typesCharacter", typed: "´", keys };
    if ([...e.key].length === 1 && !/^[a-z0-9 ]$/i.test(e.key)) {
      return { kind: "typesCharacter", typed: e.key, keys };
    }
  }
  return { kind: "keys", keys };
}
function duplicates(entries) {
  const seen = /* @__PURE__ */ new Map();
  const dups = /* @__PURE__ */ new Set();
  for (const [id, keys] of entries) {
    const norm = normalizeKeys(keys);
    if (!norm) continue;
    const other = seen.get(norm);
    if (other != null) {
      dups.add(id);
      dups.add(other);
    } else {
      seen.set(norm, id);
    }
  }
  return dups;
}
function activeKeys(stored) {
  return SHORTCUTS.filter((d) => d.ported).map((d) => [d.id, effective(d, stored)]).filter(([, b]) => b.enabled && b.keys).map(([id, b]) => [id, b.keys]);
}
const ALTGR_CHARACTERS = {
  "French (AZERTY)": {
    E: "€",
    "2": "~",
    "3": "#",
    "4": "{",
    "5": "[",
    "6": "|",
    "7": "`",
    "8": "\\",
    "9": "^",
    "0": "@"
  },
  "German (QWERTZ)": { Q: "@", E: "€", M: "µ", "2": "²", "3": "³", "7": "{", "8": "[", "9": "]", "0": "}" },
  Spanish: { E: "€", "1": "|", "2": "@", "3": "#", "4": "~", "5": "€", "6": "¬" },
  Italian: { E: "€", "5": "€" },
  Portuguese: { E: "€", "2": "@", "3": "£", "4": "§", "5": "€", "7": "{", "8": "[", "9": "]", "0": "}" },
  "Brazilian (ABNT2)": {
    Q: "/",
    W: "?",
    E: "°",
    C: "₢",
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "£",
    "5": "¢",
    "6": "¬"
  }
};
function altGrClashes(keys) {
  const c = parseKeys(keys);
  if (!c || !c.ctrl || !c.alt || c.meta) return [];
  return Object.entries(ALTGR_CHARACTERS).filter(([, chars]) => chars[c.key] != null).map(([layout]) => layout);
}
function navigate(selection, delta, itemCount) {
  if (itemCount <= 0) return null;
  if (selection != null) return Math.max(0, Math.min(itemCount - 1, selection + delta));
  return delta > 0 ? 0 : itemCount - 1;
}
function cyclePill(ids, current, delta) {
  if (ids.length === 0) return null;
  const at = Math.max(0, current == null ? 0 : ids.indexOf(current));
  return ids[((at + delta) % ids.length + ids.length) % ids.length];
}
function pillByNumber(ids, n) {
  return n >= 1 && n <= ids.length ? ids[n - 1] : null;
}
const ISLAND_SHORTCUTS = [
  { keys: "Ctrl+→ / Ctrl+←", description: SHORTCUT_TEXT.island.nextPrev },
  { keys: "Ctrl+1 – Ctrl+9", description: SHORTCUT_TEXT.island.byNumber },
  { keys: "Ctrl+↓ / Ctrl+↑", description: SHORTCUT_TEXT.island.navItems },
  { keys: "Ctrl+O", description: SHORTCUT_TEXT.island.open },
  { keys: "Ctrl+E", description: SHORTCUT_TEXT.island.diff },
  { keys: "Ctrl+Enter", description: SHORTCUT_TEXT.island.send },
  { keys: "Ctrl+K", description: SHORTCUT_TEXT.island.newChat },
  { keys: "Ctrl+,", description: SHORTCUT_TEXT.island.settings },
  { keys: "Ctrl+P", description: SHORTCUT_TEXT.island.pin },
  { keys: "Esc", description: SHORTCUT_TEXT.island.close }
];
function islandKeyAction(e, ctx) {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return null;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    if (ctx.inTextField) return null;
    return { kind: "cycle", delta: e.key === "ArrowRight" ? 1 : -1 };
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (ctx.inTextField) return null;
    return { kind: "list", delta: e.key === "ArrowDown" ? 1 : -1 };
  }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { kind: "pill", number: Number(digit[1]) };
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase();
  if (letter === "k") return ctx.view === "prompt" ? { kind: "newChat" } : null;
  if (letter === "p") return { kind: "pin" };
  if (letter === "o") return { kind: "openSelection" };
  if (letter === "e") return ctx.view === "overview" ? { kind: "diff" } : null;
  if (e.key === "," || e.code === "Comma") return { kind: "settings" };
  return null;
}
export {
  ALTGR_CHARACTERS,
  ISLAND_SHORTCUTS,
  KEY_NAMES,
  SHORTCUTS,
  SHORTCUT_TEXT,
  activeKeys,
  altGrClashes,
  cyclePill,
  displayKeys,
  duplicates,
  effective,
  formatKeys,
  islandKeyAction,
  navigate,
  normalizeKeys,
  parseKeys,
  pillByNumber,
  recordPress
};
