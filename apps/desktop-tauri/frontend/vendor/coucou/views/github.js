// Adapted from Coucou windows/src/views/github.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT.
import { h, svg, dot } from "./dom.js";
import { ICONS } from "./icons.js";
import {
  CI_COLORS,
  GH_STRINGS,
  GRID_WEEKS,
  activityHeader,
  actionsUrl,
  ciWord,
  contributionColor,
  formatCount,
  lastDays,
  lastWeeks,
  mainCISummary,
  profileUrl,
  safeGitHubUrl,
  sectionTitle,
  shortRepo,
  weekColumn
} from "../core/github.js";
const GITHUB_RED = "#F4505E";
const hooks = {
  openUrl: () => {
  },
  refresh: () => {
  }
};
let openSection = "myPRs";
function open(url) {
  const safe = safeGitHubUrl(url);
  if (safe) hooks.openUrl(safe);
}
function miniRow(activity) {
  const row2 = h("span", { class: "gh-mini" });
  for (const day of lastDays(activity, 7)) {
    row2.append(h("i", { style: `background:${contributionColor(day.level)}` }));
  }
  return row2;
}
function githubPulseCard(pulse, stats, activity, openDetail) {
  const show = (section) => {
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
  const reviews = pulse.toReview.length;
  const main = mainCISummary(pulse.mainCI);
  head.append(
    h("span", { class: "gh-count", text: `· ${GH_STRINGS.prCount(pulse.myPRs.length)}` }),
    h("button", { class: "gh-review", onclick: () => show("toReview") }, `· ${GH_STRINGS.reviewCount(reviews)}`)
  );
  const mainBtn = h("button", {
    class: "gh-ci-main",
    title: `${GH_STRINGS.mainCI}: ${main.value}`,
    "aria-label": GH_STRINGS.mainCIAria(main.value),
    onclick: () => show("mainCI")
  }, svg(main.failing ? ICONS.octagonX : ICONS.seal, 11, { evenOdd: true }));
  mainBtn.style.color = main.color;
  head.append(mainBtn);
  const shown = pulse.myPRs.slice(0, MAX_ROWS).map((pr) => prRow(pr, true));
  if (pulse.myPRs.length > MAX_ROWS) shown.push(allRow(pulse));
  return h("div", { class: "int-card" }, head, listBody(shown));
}
function backButton(title, onBack) {
  return h(
    "button",
    { class: "gh-back", onclick: onBack },
    svg(ICONS.chevronLeft, 9, { stroke: 2.6 }),
    h("span", { text: title })
  );
}
const MAX_ROWS = 4;
function allRow(pulse) {
  const go = () => open(`https://github.com/pulls?q=${encodeURIComponent("is:pr is:open author:" + pulse.login).replace(/%20/g, "+")}`);
  const el = h("button", { class: "gh-all", onclick: go, text: GH_STRINGS.seeAll(pulse.myPRs.length) });
  rowOpens.set(el, go);
  return el;
}
const CI_ICON = {
  success: ICONS.check,
  failure: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  pending: "M12 5v7l4 2.5",
  unknown: "M7 12h10"
};
function ciIcon(ci) {
  const el = h("i", { class: "gh-ci", style: `color:${CI_COLORS[ci]}` }, svg(CI_ICON[ci], 12, { stroke: 2.4 }));
  return el;
}
function ciText(ci) {
  return ciWord(ci) ?? GH_STRINGS.noCI;
}
const rowOpens = /* @__PURE__ */ new WeakMap();
function row(onOpen, ref, fullTitle, ci, line1, tail) {
  const full = `${ref} ${fullTitle}`;
  const open2 = h("button", { class: "gh-open", "aria-label": GH_STRINGS.openRef(ref), title: GH_STRINGS.openRef(ref), onclick: onOpen, text: GH_STRINGS.open });
  const el = h(
    "div",
    { class: "gh-row", title: full },
    ciIcon(ci),
    h(
      "span",
      { class: "gh-text", title: full },
      h("span", { class: "gh-line1", title: full }, ...line1),
      h("span", { class: "gh-line2", title: full }, h("span", { class: "gh-word", title: full, style: `color:${CI_COLORS[ci]}`, text: ciText(ci) }), ...tail)
    ),
    open2
  );
  rowOpens.set(el, onOpen);
  return el;
}
function prRow(pr, _showCI) {
  const ref = `${shortRepo(pr.repo)}#${pr.number}`;
  return row(
    () => open(pr.url),
    ref,
    pr.title,
    pr.ci,
    [h("span", { class: "gh-ref", title: `${ref} ${pr.title}`, text: ref }), h("span", { class: "gh-title", title: `${ref} ${pr.title}`, text: pr.title })],
    [pr.isDraft ? h("span", { class: "gh-draft", text: `· ${GH_STRINGS.draft}` }) : null]
  );
}
function repoRow(repo) {
  return row(
    () => open(actionsUrl(repo.url)),
    shortRepo(repo.repo),
    repo.branch,
    repo.ci,
    [h("span", { class: "gh-ref", text: shortRepo(repo.repo) }), h("span", { class: "gh-title", text: repo.branch })],
    []
  );
}
function listBody(rows) {
  return rows.length === 0 ? h("div", { class: "gh-empty", text: GH_STRINGS.nothingHere }) : h("div", { class: "gh-list" }, ...rows);
}
function listRows(root) {
  const list = root.querySelector(".gh-list");
  return list ? Array.from(list.children) : [];
}
function highlightRow(rows, selection, reveal) {
  rows.forEach((el, i) => el.classList.toggle("selected", i === selection));
  if (reveal && selection != null) rows[selection]?.scrollIntoView({ block: "nearest" });
}
function openRow(el) {
  if (el) rowOpens.get(el)?.();
}
function listDetail(section, pulse, onBack) {
  const rows = section === "mainCI" ? pulse.mainCI.map(repoRow) : (section === "myPRs" ? pulse.myPRs : pulse.toReview).map((pr) => prRow(pr, section === "myPRs"));
  const body = listBody(rows);
  return h(
    "div",
    { class: "int-card" },
    h("div", { class: "gh-detail-head" }, backButton(sectionTitle(section), onBack)),
    body
  );
}
function activityDetail(activity, stats, login, onBack) {
  const right = h("button", {
    class: "gh-head-right",
    text: activityHeader(activity, stats, null),
    onclick: () => open(profileUrl(login))
  });
  let picked = null;
  const show = (day) => {
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
function githubDetail(pulse, stats, activity, onBack) {
  return openSection === "activity" ? activityDetail(activity, stats, pulse.login, onBack) : listDetail(openSection, pulse, onBack);
}
export {
  githubDetail,
  githubPulseCard,
  highlightRow,
  hooks,
  listRows,
  openRow
};
