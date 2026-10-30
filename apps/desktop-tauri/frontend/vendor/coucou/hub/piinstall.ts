// HU-046 (human, verbatim option chosen: «Botón «Instalar Pi» (recomendado)»): the control that appears wherever the page learns that
// Abito's chat engine has no Pi. One trusted click shows exactly what will run; a second one runs it. The page never supplies an
// argument: it only says «run». The words of every outcome are the host's fixed sentences (`say`), never npm's output.
import { h, clear } from '../views/dom.js';
import { action, trusted } from './runtime.js';

export const PI_COMMAND = 'npm install -g @earendil-works/pi-coding-agent';
type Phase = 'idle' | 'running' | 'done' | 'failed' | 'node_ready' | 'node_installer';
const NODE_PLAN = 'Koda descarga el instalador oficial de Node.js desde nodejs.org, comprueba su huella SHA-256 y, en macOS y Windows, lo abre para que lo termines vos; en Linux lo deja en tu carpeta de usuario, sin permisos de administrador. No se instala nada sin tu clic.';
const PLAN = `Se va a ejecutar: ${PI_COMMAND}, con el Node.js de tu equipo. No pide permisos de administrador. Tarda unos minutos y se corta a los 5.`;

/** Which missing piece (if any) the engine state reports. Only the closed host codes count. */
export function missingPiece(state: any): 'pi' | 'node' | null {
  const code = state?.connection === 'no_daemon' ? state?.last_error?.code : null;
  return code === 'pi_missing' ? 'pi' : code === 'node_missing' ? 'node' : null;
}

/**
 * @param call   the page's closed host call (`call('pi_install_action', {action})`)
 * @param watch  subscribes to a host event (`pi-install:state`)
 * @param work   the page's guarded runner
 * @returns the element (hidden while nothing is missing) and `update(state)` for the page's engine state
 */
export function piInstallControl({ call, watch, work, onDone }: { call: (cmd: string, payload: any) => Promise<any>; watch: (name: string, fn: (p: any) => void) => void; work: (fn: () => Promise<any>, done?: (v: any) => void, failed?: (e: any) => void) => Promise<any>; onDone?: () => void }) {
  const box = h('div', { id: 'pi-install', class: 'pi-install', role: 'group', 'aria-label': 'Instalar Pi' });
  let missing: 'pi' | 'node' | null = null, phase: Phase = 'idle', say = '', confirming = false, finished = false, already = false, reason = '';
  const apply = (view: any) => {
    if (!view || typeof view !== 'object') return;
    const next: Phase | null = ['idle', 'running', 'done', 'failed', 'node_ready', 'node_installer'].includes(view.phase) ? view.phase : null;
    if (!next) return;
    phase = next; confirming = false;
    say = typeof view.say === 'string' ? view.say : '';
    already = view.already === true;
    reason = typeof view.reason === 'string' ? view.reason : '';
    // Node showed up since the page last looked: from here on the normal two-step «Instalar Pi» is the way (nothing was installed)
    if ((view.reason === 'node_appeared' || next === 'node_ready') && missing === 'node') missing = 'pi';
    if (next === 'done' && !finished) { finished = true; onDone?.(); }
    paint();
  };
  const run = () => {
    if (phase === 'running') return;
    phase = 'running'; confirming = false; say = ''; paint();
    work(() => call('pi_install_action', { action: 'run' }), apply, () => { phase = 'failed'; say = 'No se pudo iniciar la instalación de Pi.'; paint(); });
  };
  // Security review of HU-046: the node-missing button has its OWN closed action. It opens nodejs.org and can never start the install,
  // even if Node got installed since this page last looked (then the host answers `node_appeared` and the normal two-step takes over).
  const openNode = () => {
    work(() => call('pi_install_action', { action: 'open_node' }), apply, () => { phase = 'failed'; say = 'No se pudo abrir nodejs.org. Abrilo en tu navegador.'; paint(); });
  };
  // HU-069 (human, verbatim: «Descargar el instalador oficial de Node con un clic (recomendado)»): its own closed actions. The page never
  // supplies a URL, a version or a path; the host downloads, verifies and (mac/Windows) only OPENS the installer.
  const installNode = () => {
    work(() => call('pi_install_action', { action: 'install_node' }), apply, () => { phase = 'failed'; say = 'No se pudo iniciar la descarga de Node.js.'; paint(); });
  };
  const checkNode = () => {
    work(() => call('pi_install_action', { action: 'check_node' }), apply, () => { phase = 'failed'; say = 'No se pudo comprobar Node.js.'; paint(); });
  };
  function paint() {
    clear(box);
    box.hidden = !missing && phase !== 'running' && phase !== 'done' && phase !== 'node_installer';
    if (box.hidden) return;
    if (phase === 'running') {
      box.append(h('span', { class: 'agent-progress', role: 'status' }, h('span', { class: 'hub-progress indeterminate', 'aria-hidden': 'true' }, h('i')), h('span', { class: 'hub-note', text: 'Instalando Pi… no cierres Koda.' })));
      return;
    }
    if (phase === 'done') { box.append(h('p', { class: 'hub-note', role: 'status', text: already ? 'Pi ya estaba instalado; el chat de Koda está listo.' : 'Pi quedó instalado y el chat de Koda arrancó.' })); return; }
    if (phase === 'node_installer') {
      box.append(h('p', { class: 'hub-note', role: 'status', text: say }), action('Ya lo instalé', checkNode));
      return;
    }
    if (phase === 'node_ready') box.append(h('p', { class: 'hub-note', role: 'status', text: say }));
    if (phase === 'failed' && say) box.append(h('p', { class: 'hub-note notice err', role: 'alert', text: say }));
    if (missing === 'node') {
      box.append(h('p', { class: 'hub-note', text: 'El chat de Koda funciona con Pi, y Pi necesita Node.js, que no está instalado.' }),
        h('p', { class: 'hub-note', id: 'node-install-plan', text: NODE_PLAN }),
        action('Descargar e instalar Node.js', installNode), action('Abrir nodejs.org', openNode));
      return;
    }
    box.append(h('p', { class: 'hub-note', text: `El chat de Koda funciona con Pi, que no está instalado. Instalalo con «Instalar Pi» o desde una terminal: ${PI_COMMAND}` }));
    // «Reintentar» only after an install that really failed; after node_appeared nothing was tried, so the button is the plain «Instalar Pi»
    if (!confirming) { box.append(action(phase === 'failed' && reason !== 'node_appeared' ? 'Reintentar' : 'Instalar Pi', () => { confirming = true; paint(); })); return; }
    box.append(h('p', { class: 'hub-note', id: 'pi-install-plan', role: 'status', text: PLAN }),
      action('Instalar ahora', run), action('Cancelar', () => { confirming = false; paint(); }));
  }
  watch('pi-install:state', apply);
  work(() => call('pi_install_action', { action: 'status' }), v => { if (v?.phase === 'running') apply(v); }, () => {});
  paint();
  return { element: trusted(box), update(state: any) { const m = missingPiece(state); if (m !== missing) { missing = m; if (!m && (phase === 'failed' || phase === 'node_ready')) phase = 'idle'; paint(); } } };
}
