// Source: reference/coucou windows/src/core/plan.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { dayMonth, t, weekdayShort } from "../i18n/i18n.js";
const DAY_MS = 864e5;
const PLAN_TEXT = {
  get claudeTitle() {
    return t("Claude plan");
  },
  get codexTitle() {
    return t("Codex plan");
  },
  get claudePillTitle() {
    return t("Claude plan usage");
  },
  get codexPillTitle() {
    return t("Codex plan usage");
  },
  get waiting() {
    return t("Waiting for a response from Claude Code");
  },
  get askingCodex() {
    return t("Asking Codex…");
  },
  get justNow() {
    return t("just now");
  },
  minAgo: (n) => t("{n} min ago", { n }),
  hAgo: (n) => t("{n} h ago", { n }),
  get fiveHours() {
    return t("5 hours");
  },
  get week() {
    return t("Week");
  },
  get resets() {
    return t("Resets");
  },
  get resetting() {
    return t("Resetting…");
  },
  inHM: (h, m) => t("in {h} h {m}", { h, m }),
  inM: (m) => t("in {m} min", { m }),
  available: (n) => t("{n} available", { n }),
  until: (date) => t(" · until {date}", { date }),
  none: "—"
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const asObj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : null;
function parseClaudeWindow(raw, now) {
  const w = asObj(raw);
  const pct = w?.used_percentage;
  const epoch = w?.resets_at;
  if (!isNum(pct) || !isNum(epoch)) return void 0;
  if (pct < 0 || pct > 200) return void 0;
  if (epoch <= 0 || epoch * 1e3 > now + 400 * DAY_MS) return void 0;
  return { usedPct: Math.min(100, pct), resetsAt: epoch * 1e3 };
}
function parseClaudePlan(rateLimits, now = Date.now()) {
  const rl = asObj(rateLimits);
  const fiveHour = parseClaudeWindow(rl?.five_hour, now);
  const sevenDay = parseClaudeWindow(rl?.seven_day, now);
  if (!fiveHour && !sevenDay) return null;
  const usage = { updatedAt: now };
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;
  return usage;
}
function parseCodexPlan(result, now = Date.now()) {
  const r = asObj(result);
  const limits = asObj(r?.rateLimits);
  if (!limits) return null;
  const usage = { updatedAt: now };
  if (typeof limits.planType === "string" && limits.planType) usage.planType = limits.planType;
  for (const key of ["primary", "secondary"]) {
    const w = asObj(limits[key]);
    if (!w || !isNum(w.usedPercent) || !isNum(w.resetsAt)) continue;
    const window = {
      usedPct: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: w.resetsAt * 1e3
    };
    if (Number.isInteger(w.windowDurationMins) && w.windowDurationMins <= 24 * 60) {
      usage.fiveHour = window;
    } else {
      usage.sevenDay = window;
    }
  }
  const credits = asObj(r?.rateLimitResetCredits);
  if (credits) {
    if (Number.isInteger(credits.availableCount)) usage.resetCredits = credits.availableCount;
    const expiries = (Array.isArray(credits.credits) ? credits.credits : []).map(asObj).filter((c) => c?.status === "available" && isNum(c.expiresAt)).map((c) => c.expiresAt * 1e3);
    if (expiries.length) usage.resetCreditExpiresAt = Math.min(...expiries);
  }
  return usage.fiveHour || usage.sevenDay ? usage : null;
}
const effectivePct = (w, now = Date.now()) => w.resetsAt <= now ? 0 : w.usedPct;
function dominantPct(u, now = Date.now()) {
  const pcts = [u?.fiveHour, u?.sevenDay].filter((w) => !!w).map((w) => effectivePct(w, now));
  return pcts.length ? Math.max(...pcts) : null;
}
function planColor(pct) {
  if (pct == null) return "#6B7079";
  if (pct < 50) return "#22C55E";
  if (pct < 80) return "#F59E0B";
  return "#F4505E";
}
function pillLabel(name, u, now = Date.now()) {
  const pct = dominantPct(u, now);
  return pct == null ? `${name} ${PLAN_TEXT.none}` : `${name} ${Math.round(pct)}%`;
}
function ageLabel(updatedAt, now = Date.now()) {
  const secs = (now - updatedAt) / 1e3;
  if (secs < 60) return PLAN_TEXT.justNow;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? PLAN_TEXT.minAgo(mins) : PLAN_TEXT.hAgo(Math.floor(mins / 60));
}
function resetLabel(w, weekly, now = Date.now()) {
  const secs = (w.resetsAt - now) / 1e3;
  if (secs <= 0) return PLAN_TEXT.resetting;
  if (weekly) {
    const d = new Date(w.resetsAt);
    return `${weekdayShort(d.getDay())} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor(secs % 3600 / 60);
  return hours > 0 ? PLAN_TEXT.inHM(hours, mins) : PLAN_TEXT.inM(mins);
}
function claudeSubtitle(u, now = Date.now()) {
  return u ? ageLabel(u.updatedAt, now) : PLAN_TEXT.waiting;
}
function codexSubtitle(u, now = Date.now()) {
  if (!u) return PLAN_TEXT.askingCodex;
  return (u.planType ? `${u.planType} · ` : "") + ageLabel(u.updatedAt, now);
}
function codexResetsLabel(u) {
  if (u?.resetCredits == null) return PLAN_TEXT.none;
  let text = PLAN_TEXT.available(u.resetCredits);
  if (u.resetCredits > 0 && u.resetCreditExpiresAt != null) {
    const d = new Date(u.resetCreditExpiresAt);
    text += PLAN_TEXT.until(dayMonth(d.getMonth(), d.getDate()));
  }
  return text;
}
const CODEX_STALE_MS = 6e4;
const codexIsStale = (u, now = Date.now()) => !u || now - u.updatedAt >= CODEX_STALE_MS;
function restorePlanUsage(raw) {
  if (!raw) return null;
  try {
    const v = asObj(JSON.parse(raw));
    if (!v || !isNum(v.updatedAt)) return null;
    const win = (w) => {
      const o = asObj(w);
      return o && isNum(o.usedPct) && isNum(o.resetsAt) && o.usedPct >= 0 && o.usedPct <= 100 ? { usedPct: o.usedPct, resetsAt: o.resetsAt } : void 0;
    };
    const usage = { updatedAt: v.updatedAt };
    const fh = win(v.fiveHour);
    const sd = win(v.sevenDay);
    if (fh) usage.fiveHour = fh;
    if (sd) usage.sevenDay = sd;
    return fh || sd ? usage : null;
  } catch {
    return null;
  }
}
export {
  CODEX_STALE_MS,
  PLAN_TEXT,
  ageLabel,
  claudeSubtitle,
  codexIsStale,
  codexResetsLabel,
  codexSubtitle,
  dominantPct,
  effectivePct,
  parseClaudePlan,
  parseCodexPlan,
  pillLabel,
  planColor,
  resetLabel,
  restorePlanUsage
};
