// Adapted from Coucou src/hub/pages/{dictation,insights,words,styles,flowsettings,voice}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { card, row, button, keyLabel, label, divider, toggle, segmented } from "./ui.js";
import { notchRow, notchHint } from "./notch.js";
import { t } from "./i18n-es.js";
import { mount, modelsControl } from "./dictation-pages.js";
import { PhoneBridge, PrefsBridge } from "./flow-shim.js";
import { trusted } from "./runtime.js";
const definitions = {
  voice: ["OK Koda", "Say « OK Koda », then ask anything: add a pill, play music, the weather, an email to prepare.", "Enable"]
};
const PHONE_PORT = 47821;
const PHONE_ERRORS = {
  keystore: "No se pudo guardar la clave del enlace en el llavero de tu sesión.",
  port_in_use: `El puerto ${PHONE_PORT} ya está ocupado por otro programa.`,
  tls: "No se pudo preparar la conexión cifrada con el teléfono.",
  unsupported: "No disponible en este sistema"
};
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[(a & 3) << 4 | (b ?? 0) >> 4] + (b === void 0 ? "=" : B64[(b & 15) << 2 | (c ?? 0) >> 6]) + (c === void 0 ? "=" : B64[c & 63]);
  }
  return out;
}
const phoneReason = (error) => String(error?.message ?? error ?? "");
const phoneUnsupported = (reason) => /unsupported|not found|unknown command/i.test(reason);
const phones = (n) => n === 1 ? "1 teléfono conectado" : `${n} teléfonos conectados`;
const phonePage = async (page, ctx) => {
  const life = mount(page, ctx);
  let st = null, refused = "", busy = false;
  let usageOn = false, usageKnown = false, usageBusy = false;
  const icon = (glyph) => h("span", { class: "state-ico", "aria-hidden": "true", text: glyph });
  const status = h("div", { id: "phone-status", class: "phone-status", role: "status", "aria-live": "polite" });
  const security = h(
    "div",
    { id: "phone-security", class: "phone-security" },
    notchHint(t("Allow on the phone asks for the fingerprint or the screen lock. Deny does not.")),
    notchHint("Solo escucha en tu red local.")
  );
  const sw = trusted(toggle(false, (on) => void turn(on)));
  sw.setAttribute("aria-label", "Enlace con el teléfono");
  sw.setAttribute("aria-pressed", "false");
  const usage = trusted(toggle(false, (on) => void setUsage(on)));
  usage.setAttribute("aria-label", "Uso de los planes");
  usage.setAttribute("aria-pressed", "false");
  const steps = h(
    "ol",
    { id: "phone-steps", class: "phone-steps" },
    h("li", { text: "Abrí Kenai en el teléfono." }),
    h("li", { text: "Escaneá el código o pegá el link." }),
    h("li", { text: "Listo: tus agentes aparecen en el teléfono." })
  );
  const qr = h("div", { class: "phone-qr" });
  qr.hidden = true;
  const linkField = h("input", { id: "phone-link", class: "phone-link-field", type: "text", readonly: true, "aria-label": "Link para emparejar" });
  const copyNote = h("span", { class: "hint", role: "status" });
  const linkRow = h("div", { class: "phone-link" }, linkField, trusted(button("Copiar", () => void copyLink())), copyNote);
  linkRow.hidden = true;
  const confirm = h(
    "div",
    { id: "phone-unlink-confirm", class: "phone-confirm", role: "group" },
    h("span", { text: "¿Desemparejar este teléfono?" }),
    trusted(button("Desemparejar", () => void unpair(), "danger", true)),
    trusted(button("Cancelar", () => {
      confirm.hidden = true;
    }, "", true))
  );
  confirm.hidden = true;
  const count = h("span", { class: "hint" });
  const devices = h(
    "div",
    { id: "phone-devices", class: "phone-devices" },
    h("strong", { text: "Dispositivos" }),
    count,
    trusted(button("Desemparejar", () => {
      confirm.hidden = false;
    }, "danger", true)),
    confirm
  );
  const message = h("div", { class: "hub-note", role: "status" });
  page.append(
    ctx.hero("phone", t("Android phone"), t("Your agents and their approvals on your Android phone, over your Wi-Fi.")),
    status,
    security,
    notchHint(t("Send your agents' sessions to Koda for Android and answer permission requests from the phone. Off by default; it only listens on your local network.")),
    notchRow(t("Phone link"), sw),
    notchHint("Muestra en el teléfono cuánto usaste de Claude y Codex."),
    notchRow("Uso de los planes", usage),
    steps,
    qr,
    linkRow,
    devices,
    message
  );
  function paint() {
    const error = st?.error ?? null;
    const unknown = !st;
    const unsupported = error === "unsupported" || unknown && phoneUnsupported(refused);
    const enabled = st?.enabled === true, running = st?.running === true, clients = st?.clients ?? 0;
    sw.setAttribute("aria-pressed", String(enabled));
    sw.classList.toggle("on", enabled);
    sw.disabled = unknown || unsupported;
    usage.setAttribute("aria-pressed", String(usageOn));
    usage.classList.toggle("on", usageOn);
    usage.disabled = !usageKnown || usageBusy;
    let glyph = "○", word = "Apagado";
    if (unknown) {
      glyph = unsupported ? "·" : "✗";
      word = unsupported ? PHONE_ERRORS.unsupported : "No se pudo leer el estado del enlace.";
    } else if (error === "unsupported") {
      glyph = "·";
      word = PHONE_ERRORS.unsupported;
    } else if (error) {
      glyph = "✗";
      word = PHONE_ERRORS[error] ?? "No se pudo encender el enlace.";
    } else if (!enabled) {
      glyph = "○";
      word = "Apagado";
    } else if (!running) {
      glyph = "…";
      word = "Encendiendo…";
    } else if (clients > 0) {
      glyph = "●";
      word = phones(clients);
    } else if (st?.host) {
      glyph = "●";
      word = `Escuchando en ${st.host}:${st.port}`;
    } else {
      glyph = "●";
      word = `Escuchando en el puerto ${st.port}`;
    }
    clear(status);
    status.append(icon(glyph), h("span", { class: "state-word", text: word }));
    const svg = st?.qrSvg ?? null, link = st?.link ?? null;
    clear(qr);
    if (running && svg) {
      qr.append(h("img", { class: "phone-qr-img", src: `data:image/svg+xml;base64,${base64Utf8(svg)}`, alt: "Código QR para emparejar" }));
      qr.hidden = false;
    } else qr.hidden = true;
    if (link && !unsupported) {
      linkField.value = link;
      linkRow.hidden = false;
    } else {
      linkField.value = "";
      linkRow.hidden = true;
    }
    count.textContent = clients > 0 ? phones(clients) : "Ninguno vinculado.";
  }
  async function turn(on) {
    if (busy) return;
    busy = true;
    try {
      const next = on ? await PhoneBridge.enable() : await PhoneBridge.disable();
      if (!life.alive()) return;
      if (next) {
        st = next;
        refused = "";
        message.textContent = "";
      }
      paint();
    } catch (error) {
      if (!life.alive()) return;
      refused = phoneReason(error);
      message.textContent = phoneUnsupported(refused) ? PHONE_ERRORS.unsupported : "No se pudo cambiar el enlace. No se anuncia ningún cambio como guardado.";
      paint();
    } finally {
      busy = false;
    }
  }
  async function copyLink() {
    const link = st?.link ?? "";
    if (!link) return;
    const clip = globalThis.navigator?.clipboard;
    if (!clip?.writeText) {
      copyNote.textContent = "No se pudo copiar: seleccioná el link y copialo a mano.";
      return;
    }
    try {
      await clip.writeText(link);
      copyNote.textContent = "Copiado.";
    } catch {
      copyNote.textContent = "No se pudo copiar: seleccioná el link y copialo a mano.";
    }
  }
  async function setUsage(on) {
    if (usageBusy || !usageKnown) return;
    usageBusy = true;
    try {
      const view = await PrefsBridge.setPhoneUsage(on);
      if (life.alive() && view) {
        usageOn = view.phoneUsage === true;
        message.textContent = "";
      }
    } catch {
      if (life.alive()) message.textContent = "No se pudo guardar el uso de los planes. No se anuncia ningún cambio como guardado.";
    } finally {
      usageBusy = false;
      if (life.alive()) paint();
    }
  }
  async function unpair() {
    try {
      const next = await PhoneBridge.unlink();
      if (!life.alive()) return;
      if (next) {
        st = next;
        refused = "";
        message.textContent = "";
      }
      confirm.hidden = true;
      paint();
    } catch {
      if (!life.alive()) return;
      confirm.hidden = true;
      message.textContent = "No se pudo desemparejar: el teléfono sigue vinculado.";
    }
  }
  paint();
  try {
    const read = await PhoneBridge.status();
    if (read) {
      st = read;
      refused = "";
    }
  } catch (error) {
    refused = phoneReason(error);
  }
  try {
    const view = await PrefsBridge.view();
    if (view) {
      usageOn = view.phoneUsage === true;
      usageKnown = true;
    }
  } catch {
  }
  if (!life.alive()) return;
  paint();
  await life.listen("phone:state", (next) => {
    if (!next) return;
    st = next;
    refused = "";
    message.textContent = "";
    paint();
  });
};
function renderUnavailable(page) {
  const control = button(t("Enable"), () => {
  });
  control.disabled = true;
  return card(row("pendiente de conectar", null, control));
}
function modelControl(container, ctx) {
  const life = mount(container, ctx);
  return modelsControl(ctx, life);
}
const inertPages = Object.fromEntries(
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
    container.append(ctx.hero(page, t(title), subtitle ? t(subtitle, { 0: key }) : null, []));
    container.append(h("div", { id: "settings-root" }, card(row("pendiente de conectar", null, control))));
  }])
);
const inactivePages = { phone: phonePage, ...inertPages };
export {
  inactivePages,
  phonePage,
  renderUnavailable
};
