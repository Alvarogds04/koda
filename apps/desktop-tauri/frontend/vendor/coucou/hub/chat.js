// Adapted from Coucou src/settings/main.ts apiSection/chatProvidersSection/localSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { statusDot } from "../settings/parts.js";
import { providerDef, urlExposure } from "../core/providers.js";
import { notchSection as section, notchTipSection, notchCard, notchRow as row, notchHint as hint } from "./notch.js";
import { toggle } from "./ui.js";
import { session, trusted, foldable as foldableCard } from "./runtime.js";
import { t } from "./i18n-es.js";
import { keyAccountCommand, keyAccountId } from "./keyaccounts.js";
const UNAVAILABLE = "No disponible todavía";
const STORE = "Secret Service (GNOME Keyring, KWallet)";
const KEYS = { nan: "nan-api-key", opencodego: "opencode-go-api-key" };
const CLOUD = [
  ["google", "Google AI", "AIza…", "aistudio.google.com"],
  ["openai", "OpenAI", "sk-…", "platform.openai.com"],
  ["openrouter", "OpenRouter", "sk-or-…", "openrouter.ai/keys"],
  ["nan", "NaN", "…", "api.nan.builders"],
  ["opencodego", "OpenCode Go", "…", "opencode.ai/go (sin verificar)"]
];
const button = (key, fn, kind = "") => trusted(h("button", { class: kind, text: t(key), onclick: fn }));
const input = (type, placeholder, id) => h("input", {
  id,
  type,
  placeholder,
  autocomplete: "off",
  spellcheck: "false",
  style: "flex:1 1 auto;min-width:0"
});
async function renderChatSettings({ invoke, V, listen, timers }) {
  const s = session(invoke, listen, timers), { root, call, work, watch } = s;
  root.style.setProperty("display", "contents");
  s.message.className = "abito-settings-feedback notice err";
  const present = {};
  let state = null, prefs = {}, modelBusy = false;
  const keyRefresh = {};
  const subscriptionCleanups = [];
  function subscriptionRow(group, provider) {
    const box = h("div", { id: `chat-subscription-${group}`, title: `Usa tu suscripción de ${provider === "claude" ? "Claude" : "ChatGPT"}. El inicio de sesión se hace en tu navegador; Koda guarda el acceso solo en el llavero del sistema. Sin verificar con el proveedor.`, style: "display:flex;flex-direction:column;gap:6px;min-width:0" });
    const badge = h("span", { class: "hint", role: "status" });
    const controls = h("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0" });
    const manual = h("div", { style: "display:flex;flex-wrap:wrap;gap:8px;min-width:0" });
    const code = input("text", "Pega aquí el código", `chat-oauth-code-${provider}`);
    code.maxLength = 2048;
    code.setAttribute("aria-label", "Pega aquí el código");
    const url = h("div", { style: "user-select:text;overflow-wrap:anywhere;min-width:0", text: "" });
    const alert = h("div", { class: "hint notice err", role: "alert", "aria-live": "polite" });
    const generic = "No se pudo completar el inicio de sesión. Vuelve a intentarlo.";
    let waiting = false, busy = false, status = "", epoch = 0, timer = null;
    const stop = () => {
      if (timer !== null) (timers || globalThis).clearTimeout(timer);
      timer = null;
    };
    const paint = () => {
      badge.textContent = waiting ? "Esperando el navegador…" : status === "present" ? "✓ sesión iniciada" : status === "expired" ? "· caducada, vuelve a iniciar sesión" : status === "absent" ? "✗ sin sesión" : "· Leyendo…";
      begin.hidden = waiting || status === "present";
      begin.disabled = busy;
      logout.hidden = waiting || status !== "present";
      logout.disabled = busy;
      cancel.hidden = !waiting;
      send.disabled = busy;
      code.disabled = busy;
      manual.hidden = !waiting || provider !== "claude";
      manual.style.setProperty("display", manual.hidden ? "none" : "flex");
    };
    const refresh = (version = epoch) => work(() => call("oauth_action", { action: "status", provider }), (result2) => {
      if (version !== epoch) return;
      status = result2?.state;
      paint();
    }, () => {
      if (version === epoch) alert.textContent = generic;
    });
    const poll = (version) => {
      if (!waiting || version !== epoch || !s.alive()) return;
      timer = s.later(() => {
        timer = null;
        work(() => call("oauth_action", { action: "poll", provider }), (result2) => {
          if (version !== epoch || !waiting) return;
          if (result2?.state === "waiting") poll(version);
          else finish(result2, version);
        }, () => {
          if (version === epoch) finish({ state: "error", message: generic }, version);
        });
      }, 1500);
    };
    const finish = (result2, version) => {
      if (version !== epoch) return;
      waiting = false;
      busy = false;
      stop();
      code.value = "";
      url.textContent = "";
      if (result2?.state === "error") alert.textContent = result2.message || generic;
      paint();
      refresh(version);
    };
    const act = (action, input2) => {
      if (busy && action !== "cancel") return;
      stop();
      const version = ++epoch;
      busy = true;
      alert.textContent = "";
      url.textContent = "";
      paint();
      work(() => call("oauth_action", { action, provider, ...action === "complete" ? { input: input2 } : {} }), (result2) => {
        if (version !== epoch) return;
        busy = false;
        if (action === "begin" && result2?.state === "waiting") {
          waiting = true;
          if (provider === "claude" && result2.browserOpened === false && typeof result2.authUrl === "string") url.textContent = result2.authUrl;
          paint();
          poll(version);
        } else finish(result2, version);
      }, () => {
        if (version === epoch) finish({ state: "error", message: generic }, version);
      });
    };
    const begin = button("Iniciar sesión con suscripción", () => act("begin"));
    const logout = button("Cerrar sesión", () => act("sign_out"));
    const cancel = button("Cancelar", () => {
      code.value = "";
      waiting = false;
      act("cancel");
    });
    const send = button("Enviar", () => {
      const draft = code.value;
      code.value = "";
      if (draft) act("complete", draft);
    });
    controls.append(h("span", { text: "Suscripción" }), badge, begin, logout, cancel);
    manual.append(code, send);
    box.append(controls, manual, url, alert);
    subscriptionCleanups.push(() => {
      ++epoch;
      stop();
      waiting = false;
      code.value = "";
      url.textContent = "";
    });
    paint();
    refresh();
    return box;
  }
  function keyRow(id, title, placeholder, primary = false) {
    const field = input("password", placeholder, `chat-key-${id}`);
    field.maxLength = 2048;
    const dot = statusDot(false), feedback = h("div", {}), stateLabel = hint("");
    const stateBadge = h("span", { class: "card-state" });
    const errorId = `chat-key-error-${id}`;
    const testReason = h("div", { class: "hint test-reason", id: `chat-key-test-reason-${id}` });
    const fieldError = h("div", { class: "field-error hint", id: errorId, role: "alert", "aria-live": "polite", text: "" });
    field.setAttribute("aria-invalid", "false");
    field.setAttribute("aria-describedby", errorId);
    const invalid = (message) => {
      fieldError.textContent = message;
      field.setAttribute("aria-invalid", String(!!message));
    };
    field.addEventListener("input", (e) => {
      if (e.isTrusted) invalid("");
    });
    const eye = trusted(h("button", { class: "key-eye", type: "button", "aria-label": "Mostrar clave", "aria-pressed": "false", title: "Mostrar clave", text: "👁" }));
    const hide = () => {
      field.type = "password";
      eye.setAttribute("aria-pressed", "false");
      eye.setAttribute("aria-label", "Mostrar clave");
      eye.title = "Mostrar clave";
    };
    eye.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      eye.setAttribute("aria-pressed", String(show));
      eye.setAttribute("aria-label", show ? "Ocultar clave" : "Mostrar clave");
      eye.title = show ? "Ocultar clave" : "Mostrar clave";
    });
    let busy = false;
    const paintBadge = () => {
      const known = typeof present[id] === "boolean";
      const [icon, word, kind] = !known ? ["·", UNAVAILABLE, "unknown"] : present[id] ? ["✓", "lista", "ok"] : ["✗", "sin clave", "missing"];
      clear(stateBadge);
      stateBadge.className = `card-state ${kind}`;
      stateBadge.append(h("span", { class: "state-ico", "aria-hidden": "true", text: icon }), h("span", { class: "state-word", text: word }));
    };
    const refresh = () => {
      const known = typeof present[id] === "boolean";
      dot.style.setProperty("background", !known ? "#6b7079" : present[id] ? "#22c55e" : "#f4505e");
      stateLabel.textContent = !known ? UNAVAILABLE : t(present[id] ? "Key saved in the {store}." : "No key yet — the chat needs one.", { store: STORE });
      field.placeholder = present[id] ? `••••••••  ${t("(stored)")}` : placeholder;
      remove.hidden = !present[id];
      const can = present[id] === true;
      test.disabled = !can || busy;
      test.setAttribute("aria-disabled", String(!can));
      testReason.textContent = can ? "" : "Guarda una clave para poder probarla.";
      test.setAttribute("title", can ? "" : "Guarda una clave para poder probarla.");
      paintBadge();
    };
    const change = (action) => {
      if (busy) return;
      const value = field.value.trim();
      field.value = "";
      hide();
      if (action === "set") {
        if (!value) {
          invalid("Pega la clave antes de guardar.");
          return;
        }
        if (value.includes("\0")) {
          invalid("La clave tiene caracteres no válidos.");
          return;
        }
      }
      invalid("");
      const payload = V.keyPayload(action, id, value);
      if (!payload) return;
      busy = true;
      save.disabled = remove.disabled = test.disabled = true;
      clear(feedback);
      work(() => call("secret_action", payload), (result2) => {
        if (result2?.present !== (action === "set")) {
          feedback.append(h("div", { class: "notice err", text: "No se confirmó el cambio de la clave." }));
          return;
        }
        present[id] = result2.present;
        if (primary) feedback.append(h("div", { class: "notice ok", text: action === "set" ? t("Key saved in the {store}.", { store: STORE }) : t("Key removed.") }));
        refresh();
        const account = keyAccountCommand(id, action, value, V.ownedAccounts(state?.ownedAccounts));
        if (account) work(
          () => call("agent_action", account),
          (next) => {
            state = { ...state, ...next };
            drawModels();
          },
          () => feedback.append(h("div", { class: "notice err", text: "La clave quedó guardada, pero no se pudo crear la cuenta del chat. Créala en Cuentas." }))
        );
      }, (error) => {
        dot.style.setProperty("background", "#f5a524");
        feedback.append(h("div", { class: "notice err", text: V.keyError(error) }));
      }).finally(() => {
        busy = false;
        save.disabled = remove.disabled = false;
        refresh();
      });
    };
    const probe = () => {
      if (busy) return;
      busy = true;
      save.disabled = remove.disabled = test.disabled = true;
      clear(feedback);
      work(async () => {
        const stored = await call("secret_action", V.keyPayload("present", id));
        const next = await call("agent_action", { action: "view" });
        return { stored, next };
      }, ({ stored, next }) => {
        state = { ...state, ...next };
        present[id] = stored?.present === true;
        refresh();
        const accountId = keyAccountId(id), has = !accountId || V.ownedAccounts(state?.ownedAccounts).some((a) => a.accountId === accountId);
        feedback.append(h("div", { class: present[id] && has ? "notice ok" : "notice err", text: !present[id] ? "No hay clave guardada." : has ? "Clave guardada y cuenta del chat lista. No se contactó al proveedor." : "El chat aún no tiene cuenta para este proveedor. Vuelve a guardar la clave." }));
      }, () => feedback.append(h("div", { class: "notice err", text: "No se pudo comprobar la clave." }))).finally(() => {
        busy = false;
        save.disabled = remove.disabled = false;
        refresh();
      });
    };
    const save = button(primary ? "Save key" : "Save", () => change("set"), primary ? "primary" : "");
    const test = button("Probar", probe);
    test.setAttribute("aria-label", "Probar");
    test.type = "button";
    test.setAttribute("aria-describedby", `chat-key-test-reason-${id}`);
    const remove = button("Remove", () => change("clear"), "danger");
    const r = row(title, field, eye, save, test, remove);
    if (!primary) {
      const p = providerDef(id.replace("-api-key", ""));
      clear(r.children[0]);
      r.children[0].append(h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }), h("span", { text: title }));
    }
    keyRefresh[id] = refresh;
    refresh();
    return { r, dot, stateLabel, feedback, stateBadge, fieldError, testReason };
  }
  const api = keyRow("anthropic-api-key", t("API key"), "sk-ant-...", true);
  const models = {};
  const FALLBACK = { anthropic: [["claude-opus-5", "Claude Opus 5"], ["claude-sonnet-5", "Claude Sonnet 5"], ["claude-haiku-4-5", "Claude Haiku 4.5"]] };
  const modelPicker = (group) => {
    const select = trusted(h("select", { id: `chat-${group}-model`, "aria-label": t("Model") }));
    models[group] = select;
    select.addEventListener("change", (e) => {
      if (!e.isTrusted || select.disabled || modelBusy) return;
      const g = V.modelsTabView(state, prefs.chosenModels || {}).groups?.find((x) => x.id === group && x.connected);
      const choice = g?.models.find((m) => m.id === select.value);
      if (!choice || choice.chosen) return;
      const payload = V.chosenModelsPayload(V.chosenToggle(prefs.chosenModels || {}, group, choice.id), group);
      if (!payload) return;
      modelBusy = true;
      select.disabled = true;
      work(() => call("prefs_action", payload), (next) => {
        prefs = next;
      }).finally(() => {
        modelBusy = false;
        if (s.alive()) drawModels();
      });
    });
    return select;
  };
  function drawModels() {
    const view = V.modelsTabView(state, prefs.chosenModels || {});
    for (const [group, select] of Object.entries(models)) {
      clear(select);
      const offered = view.groups?.find((g) => g.id === group && g.connected)?.models || [];
      if (!offered.length) for (const [id, name] of FALLBACK[group] || [["", UNAVAILABLE]]) select.append(h("option", { value: id, text: name }));
      else for (const m of offered) select.append(h("option", { value: m.id, text: m.name }));
      select.value = offered.find((m) => m.chosen)?.id || offered[0]?.id || FALLBACK[group]?.[0][0] || "";
      select.disabled = modelBusy || !offered.length;
      select.title = offered.length ? "Modelos elegidos de Koda; no cambia el modelo activo de una conversación." : UNAVAILABLE;
    }
  }
  const engineSlots = {};
  const engineSlot = (group) => engineSlots[group] = h("div", { id: `chat-engine-slot-${group}` });
  const foldable = (card) => foldableCard(card, card.getAttribute("aria-label") || (card.children[0]?.firstElementChild?.textContent || card.children[0]?.textContent || "").replace(/[▾▸]/g, "").trim());
  const apiSection = notchCard("Claude", api.stateBadge, api.stateLabel, api.r, api.fieldError, api.testReason, row(t("Model"), modelPicker("anthropic")), api.feedback, subscriptionRow("anthropic", "claude"), engineSlot("anthropic"));
  apiSection.children[0].prepend(api.dot);
  foldable(apiSection);
  const providerCards = [];
  for (const [id, name, placeholder, site] of CLOUD) {
    const k = keyRow(KEYS[id] ?? providerDef(id).key, name, placeholder);
    const c = notchCard(name, k.stateBadge, k.stateLabel, k.r, k.fieldError, k.testReason, row(t("Model"), modelPicker(id)), k.feedback, engineSlot(id));
    if (id === "openai") c.append(subscriptionRow("openai", "chatgpt"));
    c.setAttribute("title", t("Key from {site}", { site }));
    c.children[0].prepend(k.dot);
    foldable(c);
    providerCards.push(c);
  }
  const locals = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  for (const [id, name, usual] of [["ollama", "Ollama", "http://127.0.0.1:11434"], ["lmstudio", "LM Studio", "http://127.0.0.1:1234"], ["custom", "OpenAI-compatible", ""]]) {
    const p = providerDef(id), block = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
    const url = input("text", usual || "https://llm.example.com", `chat-url-${id}`);
    const key = input("password", t("API key (optional)"), `chat-local-key-${id}`);
    key.disabled = true;
    key.title = UNAVAILABLE;
    const connect = button("Connect", () => {
    }, "primary");
    connect.disabled = true;
    connect.title = UNAVAILABLE;
    const exposure = h("div", {});
    const showExposure = () => {
      const kind = urlExposure(url.value || usual);
      clear(exposure);
      const copy = kind === "local" ? "Nothing leaves your PC: the server runs on this computer." : kind === "remote" ? "This address is another machine: what you ask is sent to it." : kind === "remote-http" ? "This address is another machine, over plain http: what you ask travels unencrypted." : "Not a valid http:// or https:// address.";
      if (kind !== "invalid" || url.value.trim()) exposure.append(hint(t(copy)));
    };
    url.addEventListener("input", (e) => {
      if (e.isTrusted) showExposure();
    });
    const label = h("label", {}, h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }), h("span", { text: t(name) }));
    block.append(h("div", { class: "row" }, label, url, connect));
    if (id === "custom") block.append(row("", key));
    const na = hint(UNAVAILABLE);
    na.setAttribute("title", "Conexión de direcciones arbitrarias no disponible todavía; los modelos verificados de Koda siguen debajo.");
    block.append(na, exposure);
    showExposure();
    locals.append(block);
  }
  const ctxBody = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const paintContext = () => {
    clear(ctxBody);
    const sw = trusted(toggle(prefs.windowContext === true, (value) => {
      work(() => call("prefs_action", { action: "set_window_context", window_context: value }), (next) => {
        prefs = next;
        paintContext();
      }, () => paintContext());
    }));
    sw.disabled = typeof prefs.windowContext !== "boolean";
    ctxBody.append(row(t("Active window context"), sw));
    const live = trusted(toggle(prefs.liveContext !== false, (value) => {
      work(() => call("prefs_action", { action: "set_live_context", live_context: value }), (next) => {
        prefs = next;
        paintContext();
      }, () => paintContext());
    }));
    live.disabled = typeof prefs.liveContext !== "boolean";
    ctxBody.append(row(t("Live context"), live), h("div", { class: "hub-note", text: t("When you write in the chat, Koda adds a short read-only summary of what it already knows: your coding-agent sessions, pending questions and the status of your connected integrations. It makes no new requests, and sends no keys, mail bodies or diffs. The chat still cannot run or approve anything. On by default.") }));
    const available = prefs.windowContextAvailable;
    if (prefs.windowContextNative === true) {
      ctxBody.append(h("div", { class: "hub-note", text: "Koda lee la app y el título de la ventana activa del sistema. No se captura la URL." + (typeof prefs.windowContextNote === "string" ? " Contexto " + prefs.windowContextNote + ". Para activarlo: Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla. Koda no pide ese permiso por ti." : "") }));
    } else
      ctxBody.append(h("div", { class: "hub-note", text: available === true ? "La extensión de GNOME está disponible. Solo se leen la app y el título; no se captura la URL." : available === false ? "La extensión de GNOME no está disponible. En GNOME Wayland no se pueden leer ventanas nativas sin ella; el respaldo X11 solo ve ventanas XWayland." : "No se pudo comprobar la extensión de GNOME." }));
    if (available !== true) {
      ctxBody.append(
        h("div", { class: "hub-note", text: "Para instalarla, desde la raíz del repositorio ejecuta:" }),
        h("code", { text: "sh apps/desktop-tauri/gnome-extension/install.sh" }),
        h("div", { class: "hub-note", text: "En Wayland, después de instalar una extensión nueva debes cerrar sesión y volver a entrar. Después ejecuta:" }),
        h("code", { text: "gnome-extensions enable abito-context@abito" }),
        h("div", { class: "hub-note", text: "Vuelve a abrir esta página para comprobarla. Koda no instala ni habilita la extensión automáticamente. No se captura la URL." })
      );
    }
  };
  paintContext();
  const ctxCard = notchTipSection(t("Active window context"), t("When you open the chat, Koda reads the app name and the title of the window you were using and attaches them to your first message. Off by default; nothing is read while it is off. The title goes to the model you chat with."), ctxBody);
  ctxCard.setAttribute("id", "chat-window-context");
  foldable(ctxCard);
  const localCard = section(t("Local models"), locals);
  localCard.setAttribute("title", t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."));
  localCard.setAttribute("id", "chat-local-models");
  foldable(localCard);
  const engineOthers = h("div", { id: "chat-engine-others" });
  root.append(
    apiSection,
    ...providerCards,
    engineOthers,
    h("div", { id: "chat-extras" }),
    localCard,
    ctxCard,
    s.message
  );
  drawModels();
  watch("agent:state", (next) => {
    state = { ...state, ...next };
    drawModels();
  });
  watch("prefs:state", (next) => {
    prefs = next;
    drawModels();
    paintContext();
  });
  for (const key of ["anthropic-api-key", ...CLOUD.map(([id]) => KEYS[id] ?? providerDef(id).key)]) work(() => call("secret_action", V.keyPayload("present", key)), (result2) => {
    present[key] = result2?.present === true;
    keyRefresh[key]();
  });
  for (const action of ["view", "models_list"]) work(() => call("agent_action", { action }), (next) => {
    state = { ...state, ...next };
    drawModels();
  });
  work(() => call("prefs_action", { action: "view" }), (next) => {
    prefs = next;
    drawModels();
    paintContext();
  });
  const result = s.finish(), dispose = result.dispose;
  return Object.assign(result, { dispose: () => {
    subscriptionCleanups.forEach((fn) => fn());
    dispose();
  }, slotFor: (name) => engineSlots[name] || engineOthers });
}
export {
  renderChatSettings
};
