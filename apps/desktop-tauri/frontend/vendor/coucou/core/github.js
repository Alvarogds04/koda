// Source: reference/coucou windows/src/core/github.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { dayMonth, t, tn } from "../i18n/i18n.js";
const GH_STRINGS = {
  title: "GitHub",
  get overview() {
    return t("Overview");
  },
  get totalStars() {
    return t("Total stars");
  },
  get repositories() {
    return t("Repositories");
  },
  get myPRs() {
    return t("My PRs");
  },
  get toReview() {
    return t("To review");
  },
  get mainCI() {
    return t("Default branch CI");
  },
  get activity() {
    return t("Activity");
  },
  get nothingHere() {
    return t("Nothing here");
  },
  get loading() {
    return t("Loading…");
  },
  get draft() {
    return t("Draft");
  },
  get failing() {
    return t("failing");
  },
  get running() {
    return t("running");
  },
  get passing() {
    return t("passing");
  },
  get allGreen() {
    return t("all green");
  },
  get noRepos() {
    return t("no repos");
  },
  get open() {
    return t("Open");
  },
  openRef: (ref) => t("Open {ref} on GitHub", { ref }),
  prCount: (n) => tn("{count} PR", "{count} PRs", n),
  reviewCount: (n) => tn("{count} review", "{count} reviews", n),
  get noCI() {
    return t("no CI");
  },
  mainCIAria: (state) => t("CI: {state}", { state }),
  get unknown() {
    return t("unknown");
  },
  // Design 16 (option A)
  get open() {
    return t("Open");
  },
  openRef: (ref) => t("Open {ref} on GitHub", { ref }),
  prCount: (n) => tn("{count} PR", "{count} PRs", n),
  reviewCount: (n) => tn("{count} review", "{count} reviews", n),
  get noCI() {
    return t("no CI");
  },
  seeAll: (n) => t("See all ({count}) →", { count: n }),
  mainCIAria: (state) => t("CI: {state}", { state }),
  get noContributions() {
    return t("No contributions");
  },
  get oneContribution() {
    return tn("{count} contribution", "{count} contributions", 1);
  },
  contributions: (n) => tn("{count} contribution", "{count} contributions", n),
  pastYear: (total) => t("{total} past year", { total }),
  repos: (n) => tn("{count} repo", "{count} repos", n)
};
const CI_COLORS = {
  failure: "#F4505E",
  pending: "#F5A524",
  success: "#22C55E",
  unknown: "#6B7079"
};
function contributionColor(level) {
  switch (level) {
    case 1:
      return "#0E4429";
    case 2:
      return "#006D32";
    case 3:
      return "#26A641";
    case 4:
      return "#39D353";
    default:
      return "rgba(255,255,255,0.06)";
  }
}
const isObj = (v) => typeof v === "object" && v != null;
function readPulse(data) {
  const p = data.pulse;
  if (!isObj(p) || !Array.isArray(p.myPRs) || !Array.isArray(p.toReview) || !Array.isArray(p.mainCI)) {
    return null;
  }
  return p;
}
function readActivity(data) {
  const a = data.activity;
  if (!isObj(a) || !Array.isArray(a.weeks) || typeof a.total !== "number") return null;
  return a;
}
function readStats(data) {
  if (data.totalRepos == null) return null;
  return { totalRepos: Number(data.totalRepos ?? 0), totalStars: Number(data.totalStars ?? 0) };
}
function worstCI(states) {
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  if (states.includes("success")) return "success";
  return "unknown";
}
function myPRsValue(prs) {
  const n = prs.length;
  if (n === 0) return "0";
  const failing = prs.filter((p) => p.ci === "failure").length;
  if (failing > 0) return `${n} · ${failing} ${GH_STRINGS.failing}`;
  if (prs.some((p) => p.ci === "pending")) return `${n} · ${GH_STRINGS.running}`;
  return String(n);
}
function mainCISummary(repos) {
  const worst = worstCI(repos.map((r) => r.ci));
  switch (worst) {
    case "failure": {
      const n = repos.filter((r) => r.ci === "failure").length;
      return { failing: true, color: CI_COLORS.failure, value: `${n} ${GH_STRINGS.failing}` };
    }
    case "pending":
      return { failing: false, color: CI_COLORS.pending, value: GH_STRINGS.running };
    case "success":
      return { failing: false, color: CI_COLORS.success, value: GH_STRINGS.allGreen };
    default:
      return {
        failing: false,
        color: CI_COLORS.unknown,
        value: repos.length === 0 ? GH_STRINGS.noRepos : GH_STRINGS.unknown
      };
  }
}
function ciWord(ci) {
  switch (ci) {
    case "failure":
      return GH_STRINGS.failing;
    case "pending":
      return GH_STRINGS.running;
    case "success":
      return GH_STRINGS.passing;
    default:
      return null;
  }
}
function sectionTitle(section) {
  return GH_STRINGS[section];
}
function formatCount(n) {
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function shortRepo(repo) {
  return repo.split("/").pop() || repo;
}
function safeGitHubUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "github.com") return null;
  return url.toString();
}
function actionsUrl(repoUrl) {
  return repoUrl.endsWith("/") ? `${repoUrl}actions` : `${repoUrl}/actions`;
}
function profileUrl(login) {
  return `https://github.com/${encodeURIComponent(login)}`;
}
const GRID_SQUARE = 7;
const GRID_GAP = 1.5;
const GRID_WEEKS = Math.floor((202 + GRID_GAP) / (GRID_SQUARE + GRID_GAP));
function lastWeeks(activity, n) {
  if (n <= 0) return [];
  return activity.weeks.slice(Math.max(0, activity.weeks.length - n));
}
function lastDays(activity, n) {
  if (n <= 0) return [];
  const all = activity.weeks.flat();
  return all.slice(Math.max(0, all.length - n));
}
function weekColumn(week) {
  return Array.from({ length: 7 }, (_, dow) => week.find((d) => d.weekday === dow) ?? null);
}
function dayLabel(date) {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) return date;
  return dayMonth(month - 1, day);
}
function contributionsLabel(count) {
  if (count === 0) return GH_STRINGS.noContributions;
  if (count === 1) return GH_STRINGS.oneContribution;
  return GH_STRINGS.contributions(count);
}
function totalLabel(n) {
  return n.toLocaleString("en-US");
}
function activityHeader(activity, stats, picked) {
  if (picked) return `${dayLabel(picked.date)} · ${contributionsLabel(picked.count)}`;
  if (!activity) return "";
  const total = GH_STRINGS.pastYear(totalLabel(activity.total));
  return stats ? `${total} · ${GH_STRINGS.repos(stats.totalRepos)}` : total;
}
function gitHubAlert(events) {
  let level = 0;
  let alert = null;
  for (const e of events) {
    switch (e.kind) {
      case "ciFailed":
      case "mainFailed":
        if (level < 3) {
          level = 3;
          alert = { badge: "error", sound: "error" };
        }
        break;
      case "reviewRequested":
        if (level < 2) {
          level = 2;
          alert = { badge: "finished", sound: "question" };
        }
        break;
      case "ciPassed":
        if (level < 1) {
          level = 1;
          alert = { badge: "finished", sound: "finish" };
        }
        break;
    }
  }
  return alert;
}
export {
  CI_COLORS,
  GH_STRINGS,
  GRID_GAP,
  GRID_SQUARE,
  GRID_WEEKS,
  actionsUrl,
  activityHeader,
  ciWord,
  contributionColor,
  contributionsLabel,
  dayLabel,
  formatCount,
  gitHubAlert,
  lastDays,
  lastWeeks,
  mainCISummary,
  myPRsValue,
  profileUrl,
  readActivity,
  readPulse,
  readStats,
  safeGitHubUrl,
  sectionTitle,
  shortRepo,
  totalLabel,
  weekColumn,
  worstCI
};
