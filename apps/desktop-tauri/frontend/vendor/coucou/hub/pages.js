// Adapted from Coucou src/hub/pages/{dictation,notes,insights,words,styles,flowsettings,voice}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h } from "../views/dom.js";
import { card, row, button, keyLabel, label, divider, toggle, segmented } from "./ui.js";
import { notchSection, notchRow, notchHint, infoTip } from "./notch.js";
import { t } from "./i18n-es.js";
import { mount, modelsControl } from "./dictation-pages.js";
const definitions = {
  voice: ["OK Koda", "Say « OK Koda », then ask anything: add a pill, play music, the weather, an email to prepare.", "Enable"]
};
function renderUnavailable(page) {
  if (page === "phone") {
    const inert = (el) => {
      el.disabled = true;
      el.setAttribute("title", "No disponible todavía");
      return el;
    };
    const sw = inert(toggle(false, () => {
    }));
    sw.setAttribute("aria-pressed", "false");
    sw.setAttribute("aria-label", "Enlace con el teléfono");
    const status = h(
      "div",
      { id: "phone-status", class: "phone-status", role: "status" },
      h("span", { class: "state-ico", "aria-hidden": "true", text: "○" }),
      h("span", { class: "state-word", text: "No disponible en la versión 0.2" })
    );
    const security = h(
      "div",
      { id: "phone-security", class: "phone-security" },
      notchHint(t("Allow on the phone asks for the fingerprint or the screen lock. Deny does not.")),
      notchHint("Solo escucha en tu red local.")
    );
    const steps = h(
      "ol",
      { id: "phone-steps", class: "phone-steps" },
      h("li", { text: "Abrí Koda en el teléfono." }),
      h("li", { text: "Cuando esté disponible, escaneá el código con el teléfono." }),
      h("li", { text: "Confirmá en el teléfono el código que te mostrará Koda." })
    );
    const code = h("div", { id: "phone-code", class: "hint", text: "El código de verificación aparecerá aquí cuando el enlace esté disponible." });
    const noQr = h("div", { id: "phone-no-qr", class: "hint", text: "El emparejamiento con código QR no está disponible en la versión 0.2." });
    const unlink = inert(button("Desvincular", () => {
    }, "danger", true));
    const confirm = h(
      "div",
      { id: "phone-unlink-confirm", class: "phone-confirm", role: "group" },
      h("span", { text: "¿Desvincular este teléfono?" }),
      inert(button("Desvincular", () => {
      }, "danger", true)),
      inert(button("Cancelar", () => {
      }, "", true))
    );
    confirm.hidden = true;
    const devices = h("div", { id: "phone-devices", class: "phone-devices" }, h("strong", { text: "Dispositivos" }), h("span", { class: "hint", text: "Ninguno vinculado." }), unlink, confirm);
    return notchSection(
      t("Android phone"),
      status,
      security,
      notchHint(t("Send your agents' sessions to Koda for Android and answer permission requests from the phone. Off by default; it only listens on your local network.")),
      notchRow(t("Phone link"), sw),
      steps,
      code,
      noQr,
      devices
    );
  }
  const control = button(t(page === "phone" ? "Connect" : "Enable"), () => {
  });
  control.disabled = true;
  return card(row(page === "phone" ? "No disponible" : "pendiente de conectar", null, control));
}
const NOT_YET = "No disponible todavía";
function modelControl(container, ctx) {
  const life = mount(container, ctx);
  return modelsControl(ctx, life);
}
function notesPage(container, ctx) {
  container.append(ctx.hero("notes", t("Notetaker"), null, [], true));
  container.append(card(row("No disponible todavía", null, infoTip("Transcribir llamadas persona por persona, con resumen y tareas, llegará en una versión futura. Todo se hará en este ordenador; avisá a quienes estén en la llamada de que grabás.", "Más información: Notetaker"))));
}
const inactivePages = Object.fromEntries(
  Object.entries(definitions).map(([page, [title, subtitle, action]]) => [page, (container, ctx) => {
    if (page === "voice") {
      const off = toggle(false, () => {
      });
      off.disabled = true;
      const download = modelControl(container, ctx);
      const output = segmented([["system", t("System voice")], ["elevenlabs", "ElevenLabs"], ["off", t("Text only")]], "system", () => {
      });
      for (const b of output.querySelectorAll("button")) b.disabled = true;
      container.append(
        ctx.hero("voice", "OK Koda", t(subtitle)),
        label(t("Listening")),
        card(
          row(t("Listen for « OK Koda »"), t("The microphone stays open; only what follows « OK Koda » goes further."), off),
          divider(),
          row(t("Parakeet, on your computer"), t("Hears « OK Koda » here, without the internet."), download)
        ),
        label(t("Answers")),
        card(row(t("Koda answers out loud"), null, output)),
        label(t("Privacy")),
        card(
          h("div", { class: "hub-note", text: t("Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Koda » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.") }),
          divider(),
          h("div", { class: "hub-note", text: t("An email is never sent by Koda: your mail app opens with it written, and you send it.") })
        ),
        h("div", { class: "hub-note", text: "pendiente de conectar" })
      );
      return;
    }
    const control = button(t(action), () => {
    });
    control.disabled = true;
    const key = keyLabel(ctx.status.prefs.key, ctx.status.platform);
    container.append(ctx.hero(page, t(title), subtitle ? t(subtitle, { 0: key }) : null, [], page === "notes"));
    container.append(h("div", { id: "settings-root" }, card(row("pendiente de conectar", null, control))));
  }])
);
inactivePages.notes = notesPage;
export {
  inactivePages,
  renderUnavailable
};
