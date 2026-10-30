// Adapted from Coucou windows/src/views/github.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT.
// The GitHub card once the pulse is in — DOM ports of GitHubPulseCardView,
// GitHubDetailView, GitHubPRRowView, GitHubRepoCIRowView and
// GitHubActivityDetailContent (IslandViewContent.swift). Sizes, colours and
// wording follow the Swift views; the logic lives in core/github.ts.
//
// Without a pulse (no token scope for it yet, or the first poll still to come)
// the card stays the stars + repositories overview in integrations.ts.

import { h, svg, dot } from "./dom.js";
import { ICONS } from "./icons.js";
import {
  CI_COLORS, GH_STRINGS, GRID_WEEKS, activityHeader, actionsUrl, ciWord, contributionColor,
  formatCount, lastDays, lastWeeks, mainCISummary, profileUrl, safeGitHubUrl,
  sectionTitle, shortRepo, weekColumn,
  type ContributionDay, type GitHubActivity, type GitHubPR, type GitHubPulse, type GitHubRepoCI,
  type GitHubSection, type GitHubStats,
} from "../core/github.js";

const GITHUB_RED = "#F4505E";

/**
 * Adapted for Abito: Coucou's two host calls are injected by frontend/island-github.js (`open_chat_url`,
 * `github_action {action:'refresh'}`). Until the host sets them a click does nothing.
 */
export const hooks: { openUrl(url: string): void; refresh(section: "pulse" | "activity"): void } = {
  openUrl: () => {},
  refresh: () => {},
};

/** Which list the detail view shows; kept across re-renders of the card. */
let openSection: GitHubSection = "myPRs";

function open(url: string) {
  const safe = safeGitHubUrl(url);
  if (safe) hooks.openUrl(safe);
}

/** Seven small squares: the last week of contributions. */
function miniRow(activity: GitHubActivity): HTMLElement {
  const row = h("span", { class: "gh-mini" });
  for (const day of lastDays(activity, 7)) {
    row.append(h("i", { style: `background:${contributionColor(day.level)}` }));
  }
  return row;
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function githubPulseCard(
  pulse: GitHubPulse,
  stats: GitHubStats | null,
  activity: GitHubActivity | null,
  openDetail: () => void,
): HTMLElement {
  const show = (section: GitHubSection) => {
    openSection = section;
    hooks.refresh(section === "activity" ? "activity" : "pulse");
    openDetail();
  };

  const head = h("div", { class: "int-head" }, dot(GITHUB_RED, 7), h("b", { text: GH_STRINGS.title }));
  if (stats || activity) {
    const spark = h("button", { class: "gh-spark", onclick: () => show("activity") });
    if (stats) spark.append(h("span", { text: `★ ${formatCount(stats.totalStars)}` }));
    if (activity) spark.append(miniRow(activity));
    head.append(spark);
  } else {
    head.append(h("span", { text: GH_STRINGS.overview }));
  }

  // Design 16 (option A): «GitHub · 2 PR · 1 revisión», then one row per own PR with its CI state (icon + word) and a visible [Abrir].
  const reviews = pulse.toReview.length;
  const main = mainCISummary(pulse.mainCI);
  head.append(
    h("span", { class: "gh-count", text: `· ${GH_STRINGS.prCount(pulse.myPRs.length)}` }),
    h("button", { class: "gh-review", onclick: () => show("toReview") }, `· ${GH_STRINGS.reviewCount(reviews)}`),
  );
  const mainBtn = h("button", {
    class: "gh-ci-main",
    title: `${GH_STRINGS.mainCI}: ${main.value}`,
    "aria-label": GH_STRINGS.mainCIAria(main.value),
    onclick: () => show("mainCI"),
  }, svg(main.failing ? ICONS.octagonX : ICONS.seal, 11, { evenOdd: true }));
  mainBtn.style.color = main.color;
  head.append(mainBtn);

  // At most four rows; the rest is one tap away on github.com (the list also scrolls inside the card).
  const shown = pulse.myPRs.slice(0, MAX_ROWS).map((pr) => prRow(pr, true));
  if (pulse.myPRs.length > MAX_ROWS) shown.push(allRow(pulse));
  return h("div", { class: "int-card" }, head, listBody(shown));
}

// ── Detail: lists ─────────────────────────────────────────────────────────────

function backButton(title: string, onBack: () => void): HTMLElement {
  return h(
    "button",
    { class: "gh-back", onclick: onBack },
    svg(ICONS.chevronLeft, 9, { stroke: 2.6 }),
    h("span", { text: title }),
  );
}

const MAX_ROWS = 4;

/** «Ver todas (N) →»: the full open-PR list of the user on github.com (login URL-encoded; github.com only). */
function allRow(pulse: GitHubPulse): HTMLElement {
  const go = () => open(`https://github.com/pulls?q=${encodeURIComponent("is:pr is:open author:" + pulse.login).replace(/%20/g, "+")}`);
  const el = h("button", { class: "gh-all", onclick: go, text: GH_STRINGS.seeAll(pulse.myPRs.length) });
  rowOpens.set(el, go);
  return el;
}

const CI_ICON: Record<GitHubPR["ci"], string> = {
  success: ICONS.check,
  failure: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  pending: "M12 5v7l4 2.5",
  unknown: "M7 12h10",
};

/** CI state as an icon (shape) + a word, never colour alone. */
function ciIcon(ci: GitHubPR["ci"]): HTMLElement {
  const el = h("i", { class: "gh-ci", style: `color:${CI_COLORS[ci]}` }, svg(CI_ICON[ci], 12, { stroke: 2.4 }));
  return el;
}
function ciText(ci: GitHubPR["ci"]): string {
  return ciWord(ci) ?? GH_STRINGS.noCI;
}

/** What each list row opens: its [Abrir], and Enter when it is highlighted. */
const rowOpens = new WeakMap<Element, () => void>();

/** A 36px row: state icon, two lines of text, and an explicit [Abrir] — the row itself is not a button. */
function row(onOpen: () => void, ref: string, fullTitle: string, ci: GitHubPR["ci"], line1: HTMLElement[], tail: (HTMLElement | null)[]): HTMLElement {
  // One tooltip text on every element the pointer can land on in the row (the title span truncates, but the pointer may be over the
  // reference, the CI word or the gap between them): validation v4 could not read the full title on hover.
  const full = `${ref} ${fullTitle}`;
  const open = h("button", { class: "gh-open", "aria-label": GH_STRINGS.openRef(ref), title: GH_STRINGS.openRef(ref), onclick: onOpen, text: GH_STRINGS.open });
  const el = h(
    "div",
    { class: "gh-row", title: full },
    ciIcon(ci),
    h("span", { class: "gh-text", title: full },
      h("span", { class: "gh-line1", title: full }, ...line1),
      h("span", { class: "gh-line2", title: full }, h("span", { class: "gh-word", title: full, style: `color:${CI_COLORS[ci]}`, text: ciText(ci) }), ...tail)),
    open,
  );
  rowOpens.set(el, onOpen);
  return el;
}

function prRow(pr: GitHubPR, _showCI: boolean): HTMLElement {
  const ref = `${shortRepo(pr.repo)}#${pr.number}`;
  return row(
    () => open(pr.url), ref, pr.title, pr.ci,
    [h("span", { class: "gh-ref", title: `${ref} ${pr.title}`, text: ref }), h("span", { class: "gh-title", title: `${ref} ${pr.title}`, text: pr.title })],
    [pr.isDraft ? h("span", { class: "gh-draft", text: `· ${GH_STRINGS.draft}` }) : null],
  );
}

function repoRow(repo: GitHubRepoCI): HTMLElement {
  return row(
    () => open(actionsUrl(repo.url)), shortRepo(repo.repo), repo.branch, repo.ci,
    [h("span", { class: "gh-ref", text: shortRepo(repo.repo) }), h("span", { class: "gh-title", text: repo.branch })],
    [],
  );
}

/** The bounded, internally scrolling list (max 4 rows high); «nothing here» without rows. */
function listBody(rows: HTMLElement[]): HTMLElement {
  return rows.length === 0
    ? h("div", { class: "gh-empty", text: GH_STRINGS.nothingHere })
    : h("div", { class: "gh-list" }, ...rows);
}

// ── Keyboard: Ctrl+↓ Ctrl+↑ Ctrl+O (the Mac's cardSelection) ──────────────────

/** The rows of the GitHub list shown in `root`, top to bottom; none without one. */
export function listRows(root: HTMLElement): HTMLElement[] {
  const list = root.querySelector(".gh-list");
  return list ? (Array.from(list.children) as HTMLElement[]) : [];
}

/**
 * Highlights row `selection` and no other (GitHubPRRowView's `selected`).
 * `reveal`: the highlight just moved, so its row scrolls into the three the
 * list shows.
 */
export function highlightRow(rows: readonly HTMLElement[], selection: number | null, reveal: boolean) {
  rows.forEach((el, i) => el.classList.toggle("selected", i === selection));
  if (reveal && selection != null) rows[selection]?.scrollIntoView({ block: "nearest" });
}

/** Ctrl+O: does what a click on the row does. */
export function openRow(el: HTMLElement | undefined) {
  if (el) rowOpens.get(el)?.();
}

function listDetail(section: Exclude<GitHubSection, "activity">, pulse: GitHubPulse, onBack: () => void): HTMLElement {
  const rows: HTMLElement[] =
    section === "mainCI"
      ? pulse.mainCI.map(repoRow)
      : (section === "myPRs" ? pulse.myPRs : pulse.toReview).map((pr) => prRow(pr, section === "myPRs"));
  const body = listBody(rows);

  return h(
    "div",
    { class: "int-card" },
    h("div", { class: "gh-detail-head" }, backButton(sectionTitle(section), onBack)),
    body,
  );
}

// ── Detail: contribution grid ─────────────────────────────────────────────────

function activityDetail(
  activity: GitHubActivity | null,
  stats: GitHubStats | null,
  login: string,
  onBack: () => void,
): HTMLElement {
  const right = h("button", {
    class: "gh-head-right",
    text: activityHeader(activity, stats, null),
    onclick: () => open(profileUrl(login)),
  });

  let picked: ContributionDay | null = null;
  const show = (day: ContributionDay | null) => {
    picked = day;
    right.textContent = activityHeader(activity, stats, day);
  };

  const head = h("div", { class: "gh-detail-head" }, backButton(GH_STRINGS.activity, onBack));
  if (activity) head.append(right);

  if (!activity) {
    return h("div", { class: "int-card" }, head, h("div", { class: "gh-empty", text: GH_STRINGS.loading }));
  }

  const grid = h("div", { class: "gh-grid" });
  for (const week of lastWeeks(activity, GRID_WEEKS)) {
    const column = h("div", { class: "gh-week" });
    for (const day of weekColumn(week)) {
      if (!day) {
        column.append(h("i", { class: "gh-cell empty" }));
        continue;
      }
      const cell = h("i", { class: "gh-cell", style: `background:${contributionColor(day.level)}` });
      cell.addEventListener("mouseenter", () => show(day));
      cell.addEventListener("mouseleave", () => show(null));
      cell.addEventListener("click", () => show(picked?.date === day.date ? null : day));
      column.append(cell);
    }
    grid.append(column);
  }
  return h("div", { class: "int-card" }, head, grid);
}

export function githubDetail(
  pulse: GitHubPulse,
  stats: GitHubStats | null,
  activity: GitHubActivity | null,
  onBack: () => void,
): HTMLElement {
  return openSection === "activity"
    ? activityDetail(activity, stats, pulse.login, onBack)
    : listDetail(openSection, pulse, onBack);
}
