// HU-046 (human, verbatim option chosen: «Botón «Instalar Pi» (recomendado)»): the control that appears wherever the page learns that
import { h, clear } from "../views/dom.js";
import { action, trusted } from "./runtime.js";
const PI_COMMAND = "npm install -g @earendil-works/pi-coding-agent";
const NODE_PLAN = "Koda descarga el instalador oficial de Node.js desde nodejs.org, comprueba su huella SHA-256 y, en macOS y Windows, lo abre para que lo termines vos; en Linux lo deja en tu carpeta de usuario, sin permisos de administrador. No se instala nada sin tu clic.";
const PLAN = `Se va a ejecutar: ${PI_COMMAND}, con el Node.js de tu equipo. No pide permisos de administrador. Tarda unos minutos y se corta a los 5.`;
function missingPiece(state) {
  const code = state?.connection === "no_daemon" ? state?.last_error?.code : null;
  return code === "pi_missing" ? "pi" : code === "node_missing" ? "node" : null;
}
function piInstallControl({ call, watch, work, onDone }) {
  const box = h("div", { id: "pi-install", class: "pi-install", role: "group", "aria-label": "Instalar Pi" });
  let missing = null, phase = "idle", say = "", confirming = false, finished = false, already = false, reason = "";
  const apply = (view) => {
    if (!view || typeof view !== "object") return;
    const next = ["idle", "running", "done", "failed", "node_ready", "node_installer"].includes(view.phase) ? view.phase : null;
    if (!next) return;
    phase = next;
    confirming = false;
    say = typeof view.say === "string" ? view.say : "";
    already = view.already === true;
    reason = typeof view.reason === "string" ? view.reason : "";
    if ((view.reason === "node_appeared" || next === "node_ready") && missing === "node") missing = "pi";
    if (next === "done" && !finished) {
      finished = true;
      onDone?.();
    }
    paint();
  };
  const run = () => {
    if (phase === "running") return;
    phase = "running";
    confirming = false;
    say = "";
    paint();
    work(() => call("pi_install_action", { action: "run" }), apply, () => {
      phase = "failed";
      say = "No se pudo iniciar la instalación de Pi.";
      paint();
    });
  };
  const openNode = () => {
    work(() => call("pi_install_action", { action: "open_node" }), apply, () => {
      phase = "failed";
      say = "No se pudo abrir nodejs.org. Abrilo en tu navegador.";
      paint();
    });
  };
  const installNode = () => {
    work(() => call("pi_install_action", { action: "install_node" }), apply, () => {
      phase = "failed";
      say = "No se pudo iniciar la descarga de Node.js.";
      paint();
    });
  };
  const checkNode = () => {
    work(() => call("pi_install_action", { action: "check_node" }), apply, () => {
      phase = "failed";
      say = "No se pudo comprobar Node.js.";
      paint();
    });
  };
  function paint() {
    clear(box);
    box.hidden = !missing && phase !== "running" && phase !== "done" && phase !== "node_installer";
    if (box.hidden) return;
    if (phase === "running") {
      box.append(h("span", { class: "agent-progress", role: "status" }, h("span", { class: "hub-progress indeterminate", "aria-hidden": "true" }, h("i")), h("span", { class: "hub-note", text: "Instalando Pi… no cierres Koda." })));
      return;
    }
    if (phase === "done") {
      box.append(h("p", { class: "hub-note", role: "status", text: already ? "Pi ya estaba instalado; el chat de Koda está listo." : "Pi quedó instalado y el chat de Koda arrancó." }));
      return;
    }
    if (phase === "node_installer") {
      box.append(h("p", { class: "hub-note", role: "status", text: say }), action("Ya lo instalé", checkNode));
      return;
    }
    if (phase === "node_ready") box.append(h("p", { class: "hub-note", role: "status", text: say }));
    if (phase === "failed" && say) box.append(h("p", { class: "hub-note notice err", role: "alert", text: say }));
    if (missing === "node") {
      box.append(
        h("p", { class: "hub-note", text: "El chat de Koda funciona con Pi, y Pi necesita Node.js, que no está instalado." }),
        h("p", { class: "hub-note", id: "node-install-plan", text: NODE_PLAN }),
        action("Descargar e instalar Node.js", installNode),
        action("Abrir nodejs.org", openNode)
      );
      return;
    }
    box.append(h("p", { class: "hub-note", text: `El chat de Koda funciona con Pi, que no está instalado. Instalalo con «Instalar Pi» o desde una terminal: ${PI_COMMAND}` }));
    if (!confirming) {
      box.append(action(phase === "failed" && reason !== "node_appeared" ? "Reintentar" : "Instalar Pi", () => {
        confirming = true;
        paint();
      }));
      return;
    }
    box.append(
      h("p", { class: "hub-note", id: "pi-install-plan", role: "status", text: PLAN }),
      action("Instalar ahora", run),
      action("Cancelar", () => {
        confirming = false;
        paint();
      })
    );
  }
  watch("pi-install:state", apply);
  work(() => call("pi_install_action", { action: "status" }), (v) => {
    if (v?.phase === "running") apply(v);
  }, () => {
  });
  paint();
  return { element: trusted(box), update(state) {
    const m = missingPiece(state);
    if (m !== missing) {
      missing = m;
      if (!m && (phase === "failed" || phase === "node_ready")) phase = "idle";
      paint();
    }
  } };
}
export {
  PI_COMMAND,
  missingPiece,
  piInstallControl
};
