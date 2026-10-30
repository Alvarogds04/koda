// Source: reference/coucou windows/src/core/diff.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
const DIFF_MAX_BYTES = 200 * 1024;
const DIFF_MAX_LINES = 4e3;
const DIFF_MAX_CELLS = 1e6;
const CONTEXT = 3;
const encoder = new TextEncoder();
const utf8Length = (s) => encoder.encode(s).length;
function fileName(path) {
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
function fromEdit(oldText, newText, path) {
  if (utf8Length(oldText) + utf8Length(newText) > DIFF_MAX_BYTES) {
    return countFallback(oldText, newText, path);
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length + newLines.length > DIFF_MAX_LINES) {
    return countFallback(oldText, newText, path);
  }
  if (oldLines.length * newLines.length > DIFF_MAX_CELLS) {
    return countFallback(oldText, newText, path);
  }
  const flat = buildDiffLines(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const l of flat) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return {
    id: 0,
    path,
    added,
    removed,
    hunks: buildHunks(flat, CONTEXT),
    tooLarge: false,
    isNewFile: false
  };
}
function fromNew(content, path) {
  if (utf8Length(content) > DIFF_MAX_BYTES) {
    const lineCount = content.split("\n").length;
    return { id: 0, path, added: lineCount, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const lines = splitLines(content);
  if (lines.length > DIFF_MAX_LINES) {
    return { id: 0, path, added: lines.length, removed: 0, hunks: [], tooLarge: true, isNewFile: true };
  }
  const diffLines = lines.map((text, i) => ({
    kind: "added",
    text,
    origLine: -1,
    newLine: i + 1
  }));
  return {
    id: 0,
    path,
    added: diffLines.length,
    removed: 0,
    hunks: diffLines.length ? [{ origStart: 0, newStart: 1, lines: diffLines }] : [],
    tooLarge: false,
    isNewFile: true
  };
}
function buildFileDiff(tool, input) {
  const str = (v) => typeof v === "string" ? v : null;
  const path = str(input.file_path);
  switch (tool) {
    case "Edit": {
      const oldText = str(input.old_string);
      const newText = str(input.new_string);
      if (oldText == null || newText == null || path == null) return null;
      if (!oldText && !newText) return null;
      const d = fromEdit(oldText, newText, path);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    case "MultiEdit": {
      const edits = input.edits;
      if (path == null || !Array.isArray(edits) || edits.length === 0) return null;
      let added = 0;
      let removed = 0;
      let tooLarge = false;
      const hunks = [];
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit;
        const oldText = str(e.old_string);
        const newText = str(e.new_string);
        if (oldText == null || newText == null) continue;
        const d = fromEdit(oldText, newText, path);
        added += d.added;
        removed += d.removed;
        hunks.push(...d.hunks);
        if (d.tooLarge) tooLarge = true;
      }
      if (added === 0 && removed === 0) return null;
      return { id: 0, path, added, removed, hunks, tooLarge, isNewFile: false };
    }
    case "Write": {
      const content = str(input.content);
      if (path == null || !content) return null;
      const d = fromNew(content, path);
      return d.added > 0 || d.removed > 0 ? d : null;
    }
    default:
      return null;
  }
}
function splitLines(text) {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}
function buildDiffLines(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const w = n + 1;
  const dp = new Uint16Array((m + 1) * w);
  for (let i2 = 1; i2 <= m; i2++) {
    for (let j2 = 1; j2 <= n; j2++) {
      dp[i2 * w + j2] = oldLines[i2 - 1] === newLines[j2 - 1] ? dp[(i2 - 1) * w + j2 - 1] + 1 : Math.max(dp[(i2 - 1) * w + j2], dp[i2 * w + j2 - 1]);
    }
  }
  const matches = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  const result = [];
  let prevOld = -1;
  let prevNew = -1;
  const removedLine = (k) => ({ kind: "removed", text: oldLines[k], origLine: k + 1, newLine: -1 });
  const addedLine = (k) => ({ kind: "added", text: newLines[k], origLine: -1, newLine: k + 1 });
  for (const [oi, ni] of matches) {
    for (let k = prevOld + 1; k < oi; k++) result.push(removedLine(k));
    for (let k = prevNew + 1; k < ni; k++) result.push(addedLine(k));
    result.push({ kind: "context", text: oldLines[oi], origLine: oi + 1, newLine: ni + 1 });
    prevOld = oi;
    prevNew = ni;
  }
  for (let k = prevOld + 1; k < m; k++) result.push(removedLine(k));
  for (let k = prevNew + 1; k < n; k++) result.push(addedLine(k));
  return result;
}
function buildHunks(lines, context) {
  const merged = [];
  lines.forEach((line, i) => {
    if (line.kind === "context") return;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged.map(([start, end]) => {
    const hunkLines = lines.slice(start, end + 1);
    return {
      origStart: hunkLines.find((l) => l.origLine > 0)?.origLine ?? 1,
      newStart: hunkLines.find((l) => l.newLine > 0)?.newLine ?? 1,
      lines: hunkLines
    };
  });
}
function countFallback(oldText, newText, path) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => l !== "" && !oldSet.has(l)).length;
  const removed = oldLines.filter((l) => l !== "" && !newSet.has(l)).length;
  return { id: 0, path, added, removed, hunks: [], tooLarge: true, isNewFile: false };
}
function toOneLine(text, maxChars = 200) {
  const trimWS = (s) => s.replace(/^[ \t]+|[ \t]+$/g, "");
  const paragraphs = [];
  let current = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = trimWS(line);
    const isHR = t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
    if (t === "" || isHR || t.startsWith("|")) {
      if (current.length) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current);
  for (const para of paragraphs) {
    const s = para.join("\n").replaceAll("**", "").replaceAll("__", "").replaceAll("`", "");
    const processed = [];
    for (const line of s.split("\n")) {
      let l = trimWS(line.replace(/^#+/, ""));
      if (l.startsWith("- ") || l.startsWith("* ") || l.startsWith("• ")) l = l.slice(2);
      else l = l.replace(/^\d+\.\s+/, "");
      l = trimWS(l);
      if (l) processed.push(l);
    }
    const collapsed = processed.join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) return Array.from(collapsed).slice(0, maxChars).join("");
  }
  return "";
}
const DIFF_STEP_MARKER = "";
function isDiffStep(step) {
  return step.startsWith(DIFF_STEP_MARKER);
}
function makeDiffStep(filename, added, removed, diffId) {
  return `${DIFF_STEP_MARKER}${filename}	${added}:${removed}:${diffId}`;
}
function parseDiffStep(step) {
  if (!isDiffStep(step)) return null;
  const body = step.slice(DIFF_STEP_MARKER.length);
  const tab = body.indexOf("	");
  if (tab < 0) return null;
  const parts = body.slice(tab + 1).split(":");
  if (parts.length !== 3 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
  const [added, removed, diffId] = parts.map(Number);
  return { filename: body.slice(0, tab), added, removed, diffId };
}
function lastTextStep(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!isDiffStep(steps[i])) return steps[i];
  }
  return void 0;
}
export {
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  DIFF_STEP_MARKER,
  buildFileDiff,
  fileName,
  fromEdit,
  fromNew,
  isDiffStep,
  lastTextStep,
  makeDiffStep,
  parseDiffStep,
  toOneLine
};
