// Source: reference/coucou windows/src/recap/summary.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { N_, dayMonth, t } from "../i18n/i18n.js";
const DEFAULT_PREFS = { enabled: true, hideProjects: false, lastShownWeek: "" };
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function mondayOf(d) {
  const sinceMonday = (d.getDay() + 6) % 7;
  return addDays(d, -sinceMonday);
}
function previousWeekStart(now) {
  return addDays(mondayOf(now), -7);
}
function dayKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const RECAP_HOUR = 8;
function shouldAutoShow(now, lastShownWeek) {
  return now.getDay() === 1 && now.getHours() >= RECAP_HOUR && dayKey(mondayOf(now)) !== lastShownWeek;
}
const DAY_NAMES = [N_("Sunday"), N_("Monday"), N_("Tuesday"), N_("Wednesday"), N_("Thursday"), N_("Friday"), N_("Saturday")];
const AGENT_NAMES = {
  integration_claude: "Claude Code",
  agent_cursor: "Cursor",
  agent_antigravity: "Antigravity",
  agent_codex: "Codex",
  agent_gemini: "Gemini CLI",
  agent_copilot: "Copilot CLI",
  agent_muse: "Muse Code",
  agent_opencode: "OpenCode",
  agent_amp: "Amp",
  agent_hermes: "Hermes",
  "agent_claude-desktop": "Claude Desktop"
};
function agentName(id) {
  const known = AGENT_NAMES[id];
  if (known) return known;
  const raw = id.replace(/^agent_/, "");
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : id;
}
function topKey(counts, order) {
  let best = null;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount || n === bestCount && best !== null && order(key, best) < 0) {
      best = key;
      bestCount = n;
    }
  }
  return best;
}
function mergedSeconds(turns) {
  const sorted = turns.filter((t2) => t2.end > t2.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let segStart = 0;
  let segEnd = -Infinity;
  for (const t2 of sorted) {
    if (t2.start <= segEnd) {
      segEnd = Math.max(segEnd, t2.end);
    } else {
      if (segEnd > segStart) total += segEnd - segStart;
      segStart = t2.start;
      segEnd = t2.end;
    }
  }
  if (segEnd > segStart) total += segEnd - segStart;
  return total;
}
function summarize(history, weekStart) {
  const end = addDays(weekStart, 7);
  const from = weekStart.getTime() / 1e3;
  const to = end.getTime() / 1e3;
  const turns = history.turns.filter((t2) => t2.start >= from && t2.start < to);
  if (turns.length === 0) return null;
  const decisions = history.decisions.filter((d) => d.date >= from && d.date < to);
  const sum = (f) => turns.reduce((n, t2) => n + f(t2), 0);
  const byAgent = /* @__PURE__ */ new Map();
  const byProject = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  for (const t2 of turns) {
    byAgent.set(t2.agent, (byAgent.get(t2.agent) ?? 0) + 1);
    if (t2.project) byProject.set(t2.project, (byProject.get(t2.project) ?? 0) + 1);
    const day = new Date(t2.start * 1e3).getDay();
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const byName = (a, b) => a.localeCompare(b);
  const byWeekOrder = (a, b) => (a + 6) % 7 - (b + 6) % 7;
  const topAgent = topKey(byAgent, byName);
  const busiest = topKey(byDay, byWeekOrder);
  const longest = Math.max(0, ...turns.map((t2) => t2.end - t2.start));
  return {
    weekStart,
    weekEnd: new Date(end.getTime() - 1e3),
    totalMinutes: Math.floor(mergedSeconds(turns) / 60),
    sessionCount: turns.length,
    filesChanged: sum((t2) => t2.filesChanged),
    linesAdded: sum((t2) => t2.linesAdded),
    linesRemoved: sum((t2) => t2.linesRemoved),
    commandsRun: sum((t2) => t2.commandsRun),
    questions: sum((t2) => t2.questions),
    permissionsAllowed: decisions.filter((d) => d.decision === "allow" || d.decision === "always").length,
    permissionsDenied: decisions.filter((d) => d.decision === "deny").length,
    topAgent: topAgent === null ? null : agentName(topAgent),
    topProject: topKey(byProject, byName),
    busiestDay: busiest === null ? null : DAY_NAMES[busiest],
    longestSessionMinutes: Math.floor(longest / 60)
  };
}
function formatDuration(minutes) {
  if (minutes < 60) return t("{n}m", { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? t("{n}h", { n: h }) : t("{h}h {m}m", { h, m });
}
function formatCount(n) {
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return n.toLocaleString("en-US");
}
function weekRangeLabel(s) {
  const f = (d) => dayMonth(d.getMonth(), d.getDate());
  return `${f(s.weekStart)} – ${f(s.weekEnd)}`;
}
function sampleHistory(monday) {
  const at = (day, hour, minute = 0) => Math.floor(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, hour, minute).getTime() / 1e3);
  const turn = (agent, project, start, end, filesChanged, linesAdded, linesRemoved, commandsRun, questions) => ({ agent, project, start, end, filesChanged, linesAdded, linesRemoved, commandsRun, questions });
  const claude = "integration_claude";
  return {
    turns: [
      turn(claude, "coucou", at(0, 9), at(0, 11, 30), 8, 312, 87, 14, 2),
      turn(claude, "coucou", at(0, 14), at(0, 15, 45), 3, 95, 20, 5, 0),
      turn("agent_gemini", "side-project", at(1, 10), at(1, 11), 2, 50, 10, 3, 1),
      turn(claude, "coucou", at(2, 9, 30), at(2, 12), 5, 180, 60, 8, 3),
      turn(claude, "coucou", at(3, 16), at(3, 17), 1, 40, 5, 2, 0),
      turn(claude, "coucou", at(4, 8), at(4, 13), 12, 540, 130, 22, 5)
    ],
    decisions: [
      { agent: claude, date: at(0, 9, 30), decision: "allow" },
      { agent: claude, date: at(0, 10), decision: "allow" },
      { agent: claude, date: at(2, 10), decision: "deny" },
      { agent: claude, date: at(4, 9), decision: "always" },
      { agent: claude, date: at(4, 10), decision: "allow" }
    ],
    prefs: { ...DEFAULT_PREFS }
  };
}
export {
  DEFAULT_PREFS,
  RECAP_HOUR,
  addDays,
  agentName,
  dayKey,
  formatCount,
  formatDuration,
  mergedSeconds,
  mondayOf,
  previousWeekStart,
  sampleHistory,
  shouldAutoShow,
  summarize,
  weekRangeLabel
};
