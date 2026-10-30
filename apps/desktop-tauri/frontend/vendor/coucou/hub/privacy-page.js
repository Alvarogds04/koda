// Abito-owned (#503 «reportar fallos», S4-S6). The page is live through the closed `failure_action` command.
// Nothing leaves the machine until the human clicks «Reportar»; the text shown (and editable) is exactly what is sent.
import { h } from "../views/dom.js";
import { card, row, button, label, toggle } from "./ui.js";
import { trusted } from "./runtime.js";
import { infoTip } from "./notch.js";
// 0.2.1 (S7, L2): the explanation of a row is an ⓘ beside its title; what is sent and the GitHub step stay visible.
const tipRow = (title, tip, ...trailing) => row(title, null, infoTip(tip, `Más información: ${title}`), ...trailing);
export async function privacyPage(page, ctx, invoke) {
  let alive = true, st = { enabled: true, pending: [] }, draft = null, msg = "";
  ctx.onLeave = () => { alive = false; };
  const call = (payload) => invoke("failure_action", { payload });
  try { st = await call({ action: "view" }); } catch { msg = "No se pudo leer el estado de los avisos."; }
  const box = h("div", {});
  page.append(ctx.hero("privacy", "Privacidad", "Avisos de fallos. Nada se envía sin tu confirmación."), box);
  const say = (text) => { msg = text; draw(); };
  const guard = async (fn) => { try { await fn(); } catch { if (alive) say("No se pudo completar. No se anuncia ningún cambio como hecho."); } };
  async function preview(fingerprint) {
    await guard(async () => { const p = await call(fingerprint ? { action: "preview", fingerprint } : { action: "preview" }); if (alive) { draft = p; msg = ""; draw(); } });
  }
  async function refresh(next) { if (alive) { st = next; draft = null; draw(); } }
  function editor() {
    const title = h("input", { class: "hub-input", type: "text", value: draft.title, "aria-label": "Título del reporte" });
    const body = h("textarea", { class: "hub-input", rows: "14", "aria-label": "Texto del reporte", style: "width:100%;font-family:monospace" });
    body.value = draft.body;
    const send = trusted(button("Reportar", () => guard(async () => {
      const r = await call({ action: "send", title: title.value, body: body.value });
      say(r.copied ? "El texto es largo: lo copié al portapapeles. Pegalo en la página de GitHub que se abrió y apretá «Create»." : "Se abrió GitHub con el reporte listo. Revisalo y apretá «Create» si querés enviarlo.");
      draft = null; draw();
    }), "primary"));
    const link = h("a", { href: draft.searchUrl, target: "_blank", rel: "noopener noreferrer", text: "Buscar si ya existe en GitHub", class: "hub-note" });
    const cancel = trusted(button("Ahora no", () => { draft = null; draw(); }));
    const never = draft.fingerprint && st.pending.some((f) => f.fingerprint === draft.fingerprint)
      ? trusted(button("No volver a preguntar por este fallo", () => guard(async () => refresh(await call({ action: "never", fingerprint: draft.fingerprint }))))) : null;
    return card(tipRow("Esto es exactamente lo que se enviará", "Sin conversaciones, claves ni rutas personales. Podés editarlo antes de enviar."),
      h("div", { style: "padding:0 16px 8px" }, title), h("div", { style: "padding:0 16px 8px" }, body),
      h("div", { style: "padding:0 16px 8px" }, link),
      h("div", { style: "display:flex;gap:8px;padding:0 16px 16px" }, send, cancel, ...(never ? [never] : [])));
  }
  function draw() {
    box.replaceChildren();
    box.append(label("Avisos de fallos"));
    box.append(card(tipRow("Avisarme de problemas", "Se guardan solo en esta computadora. Nada sale sin tu confirmación.",
      trusted(toggle(st.enabled, (v) => guard(async () => refresh(await call({ action: "set_enabled", enabled: v }))))))));
    if (st.enabled && st.pending.length) {
      box.append(label("Koda tuvo un problema. ¿Querés reportarlo?"));
      box.append(card(...st.pending.map((f) => row(`${f.step} · ${f.process}`, f.count > 1 ? `Pasó ${f.count} veces` : null,
        trusted(button("Reportar", () => preview(f.fingerprint), "primary", true)),
        trusted(button("Ahora no", () => guard(async () => refresh(await call({ action: "later", fingerprint: f.fingerprint }))), "", true)),
        trusted(button("No volver a preguntar", () => guard(async () => refresh(await call({ action: "never", fingerprint: f.fingerprint }))), "", true))))));
    }
    box.append(label("Reporte manual"));
    box.append(card(tipRow("Reportar un problema", "Armá un reporte vos mismo; ves el texto completo antes de enviarlo.", trusted(button("Reportar un problema", () => preview(null))))));
    if (draft) box.append(editor());
    if (msg) box.append(h("div", { class: "hub-note", role: "status", text: msg }));
  }
  draw();
}
