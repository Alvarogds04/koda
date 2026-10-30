// Adapted from Coucou windows/src/views/recap.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "./dom.js";
import { dayKey, formatCount, formatDuration, weekRangeLabel } from "../recap/summary.js";
import { t } from "../i18n/i18n.js";
const T = {
  get title() {
    return t("Weekly recap");
  },
  get noActivity() {
    return t("No activity last week");
  },
  get noActivitySub() {
    return t("Koda counts your agent sessions as they happen — check back next Monday.");
  },
  get coding() {
    return t("coding");
  },
  get session() {
    return t("session");
  },
  get sessions() {
    return t("sessions");
  },
  get file() {
    return t("file");
  },
  get files() {
    return t("files");
  },
  get lines() {
    return t("lines");
  },
  get commands() {
    return t("commands");
  },
  get topAgent() {
    return t("Top agent");
  },
  get topProject() {
    return t("Top project");
  },
  get busiestDay() {
    return t("Busiest day");
  },
  get longest() {
    return t("Longest session");
  },
  get permissions() {
    return t("Permissions");
  },
  allowedDenied: (allowed, denied) => t("{allowed} allowed, {denied} denied", { allowed, denied }),
  get questions() {
    return t("Questions");
  },
  get shareImage() {
    return t("Share image");
  },
  get shareUnavailable() {
    return t("The share image is not available in Koda yet.");
  },
  get ok() {
    return t("OK");
  }
};
function btn(label, kind, onClick) {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}
function chip(value, label) {
  return h(
    "div",
    { class: "recap-chip" },
    h("div", { class: "v", text: value }),
    h("div", { class: "l", text: label })
  );
}
function metaLine(pairs) {
  if (pairs.length === 0) return null;
  const el = h("div", { class: "recap-meta" });
  pairs.forEach(([label, value], i) => {
    if (i > 0) el.append(h("span", { class: "sep", text: "·" }));
    el.append(h("span", { text: label }), h("span", { class: "n", text: value }));
  });
  return el;
}
const plural = (n, one, many) => n === 1 ? one : many;
function summaryBody(s, onOk) {
  const chips = h(
    "div",
    { class: "recap-chips" },
    chip(formatDuration(s.totalMinutes), T.coding),
    chip(formatCount(s.sessionCount), plural(s.sessionCount, T.session, T.sessions)),
    chip(formatCount(s.filesChanged), plural(s.filesChanged, T.file, T.files))
  );
  if (s.linesAdded + s.linesRemoved > 0) {
    chips.append(chip(`+${formatCount(s.linesAdded)} / −${formatCount(s.linesRemoved)}`, T.lines));
  }
  if (s.commandsRun > 0) chips.append(chip(formatCount(s.commandsRun), T.commands));
  const first = [];
  if (s.topAgent) first.push([T.topAgent, s.topAgent]);
  if (s.topProject) first.push([T.topProject, s.topProject]);
  if (s.busiestDay) first.push([T.busiestDay, t(s.busiestDay)]);
  const second = [];
  if (s.longestSessionMinutes > 1) second.push([T.longest, formatDuration(s.longestSessionMinutes)]);
  if (s.permissionsAllowed + s.permissionsDenied > 0) {
    second.push([T.permissions, T.allowedDenied(s.permissionsAllowed, s.permissionsDenied)]);
  }
  if (s.questions > 0) second.push([T.questions, formatCount(s.questions)]);
  const share = btn(T.shareImage, "primary", () => {
  });
  share.disabled = true;
  share.title = T.shareUnavailable;
  return h(
    "div",
    { class: "stack recap-stack" },
    h(
      "div",
      { class: "recap-head" },
      h("span", { class: "recap-title", text: T.title }),
      h("span", { class: "grow" }),
      h("span", { class: "recap-range", text: weekRangeLabel(s) })
    ),
    chips,
    metaLine(first),
    metaLine(second),
    h("div", { class: "actions" }, share, btn(T.ok, "secondary", onOk))
  );
}
function emptyBody(onOk) {
  return h(
    "div",
    { class: "stack recap-stack" },
    h("div", { class: "title", text: T.noActivity }),
    h("div", { class: "sub", text: T.noActivitySub }),
    h("div", { class: "actions" }, btn(T.ok, "secondary", onOk))
  );
}
function buildRecapCard(summary, onOk) {
  const card = h("div", { class: "card wash recap-card" });
  card.style.setProperty("--wash", "rgba(99,102,241,0.5)");
  clear(card);
  card.append(summary ? summaryBody(summary, onOk) : emptyBody(onOk));
  return card;
}
export {
  buildRecapCard,
  dayKey,
  emptyBody,
  summaryBody
};
