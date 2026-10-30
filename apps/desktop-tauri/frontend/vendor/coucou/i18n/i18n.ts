// Abito-owned replacement for reference/coucou windows/src/i18n/i18n.ts @434d6a2b.
// Fixed Spanish subset: no upstream translation tables or branded copy.
// Extraction marker only: this does not bypass t()'s fail-closed lookup.
export function N_(key: string): string { return key; }
// Adapted for Abito: only General's used keys added, short neutral Spanish copy.
const messages = {
  Color: "Color", Default: "Predeterminado",
  General: "General", Sound: "Sonido", "Open on hover": "Abrir al pasar el cursor",
  "Hovering the island opens it; it folds again shortly after the pointer leaves. Click inside to keep it open.": "La isla se abre al pasar el cursor y se cierra al salir. Haz clic dentro para mantenerla abierta.",
  "Auto-close": "Cierre automático", "seconds after you leave the island": "segundos tras salir de la isla",
  "0 means never": "0 = nunca", "Island lives on": "Pantalla de la isla", "Main display": "Pantalla principal",
  Back: "Volver", "Open in VS Code": "Abrir en VS Code", "Diff too large": "Diff demasiado grande", "No changes": "Sin cambios",
  // S10 (L30): plan usage (views/usage.ts, core/plan.ts)
  "Claude plan": "Plan de Claude", "Codex plan": "Plan de Codex", "Claude plan usage": "Uso del plan de Claude", "Codex plan usage": "Uso del plan de Codex",
  "Waiting for a response from Claude Code": "Esperando una respuesta de Claude Code", "Asking Codex…": "Consultando a Codex…",
  "just now": "ahora mismo", "{n} min ago": "hace {n} min", "{n} h ago": "hace {n} h", "5 hours": "5 horas", Week: "Semana",
  Resets: "Reinicios", "Resetting…": "Reiniciando…", "in {h} h {m}": "en {h} h {m}", "in {m} min": "en {m} min",
  "{n} available": "{n} disponibles", " · until {date}": " · hasta {date}",
  // S10 (L30): GitHub card (views/github.ts, core/github.ts)
  Overview: "Resumen", "Total stars": "Estrellas", Repositories: "Repositorios", "My PRs": "Mis PRs", "To review": "Por revisar",
  "Default branch CI": "CI de la rama", Activity: "Actividad", "Nothing here": "Nada por aquí", "Loading…": "Cargando…",
  Draft: "Borrador", failing: "fallando", running: "en curso", passing: "pasando", "all green": "todo en verde", "no repos": "sin repos",
  unknown: "desconocido", "No contributions": "Sin contribuciones", "{total} past year": "{total} el último año",
  "{count} contribution": "{count} contribución", "{count} contributions": "{count} contribuciones",
  "{count} repo": "{count} repo", "{count} repos": "{count} repos",
  // Design 16 (option A): PR list with CI state and an explicit action
  Open: "Abrir", "Open {ref} on GitHub": "Abrir {ref} en GitHub", "{count} PR": "{count} PR", "{count} PRs": "{count} PR",
  "{count} review": "{count} revisión", "{count} reviews": "{count} revisiones", "no CI": "sin CI", "See all ({count}) →": "Ver todas ({count}) →", "CI: {state}": "CI de la rama: {state}",
  // S10 (L30): weekly recap (views/recap.ts, recap/summary.ts)
  "Weekly recap": "Resumen semanal", "No activity last week": "Sin actividad la semana pasada",
  "Koda counts your agent sessions as they happen — check back next Monday.": "Koda cuenta tus sesiones de agentes a medida que ocurren: volvé el próximo lunes.",
  coding: "programando", session: "sesión", sessions: "sesiones", file: "archivo", files: "archivos", lines: "líneas", commands: "comandos",
  "Top agent": "Agente principal", "Top project": "Proyecto principal", "Busiest day": "Día más activo", "Longest session": "Sesión más larga",
  Permissions: "Permisos", "{allowed} allowed, {denied} denied": "{allowed} permitidos, {denied} denegados", Questions: "Preguntas",
  "Share image": "Compartir imagen", "The share image is not available in Koda yet.": "La imagen para compartir todavía no está disponible en Koda.", OK: "OK",
  Sunday: "domingo", Monday: "lunes", Tuesday: "martes", Wednesday: "miércoles", Thursday: "jueves", Friday: "viernes", Saturday: "sábado",
  "{n}m": "{n} min", "{n}h": "{n} h", "{h}h {m}m": "{h} h {m} min",
  "Unavailable features": "No disponible en Koda todavía: carpeta de sonidos; recarga y contador de sonidos; inicio automático; idioma; resumen.",
} as const;
/** `{name}` placeholders, filled from `vars` (Coucou's interpolate). A missing variable stays as written. */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
}
export function t(key: string, vars?: Record<string, string | number>): string {
  if (!Object.prototype.hasOwnProperty.call(messages, key)) throw new Error(`Traducción de Koda no disponible: ${key}`);
  return interpolate(messages[key as keyof typeof messages], vars);
}
/** A count with its words: Spanish has two forms, singular for exactly 1. */
export function tn(one: string, other: string, count: number, vars?: Record<string, string | number>): string {
  return t(count === 1 ? one : other, { ...vars, count });
}
/** The fixed interface language (Abito ships Spanish only here). */
export function language(): string { return "es"; }
const ES_WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "lun" for Monday (0 = Sunday). */
export function weekdayShort(day: number): string { return ES_WEEKDAYS[day] ?? ""; }
/** "9 oct" (months from 0). */
export function dayMonth(month: number, day: number): string { return `${day} ${ES_MONTHS[month] ?? ""}`; }
// Compatibility for the unmodified DOM helper's instanceof and subscription.
// This subset has no language switching: there is nothing to subscribe to.
export class Msg {
  constructor(readonly key: string) {}
  toString(): string { return t(this.key); }
}
// Coucou's tl(): a message that follows the language (here: the fixed Spanish subset).
export function tl(key: string): Msg { return new Msg(key); }
export function onLanguageChange(_listener: () => void): () => void {
  return () => {};
}
