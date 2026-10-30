'use strict';
/* HU-063 T1: browser mount of the «sidebar Koda» in the Ajustes hub. Additive: it only inserts one block (veil + Koda x3 + phrase)
   at the top of the hub sidebar built by vendor/coucou/hub/shell.js and follows the rail's active item. All decisions come from the
   pure model (settings-nusa.js); the sprite uses koda-catalog.js / koda-logic.js untouched. No IPC, no HTML-string injection, no vendor edit. */
(function () {
  const doc = document, M = window.AbitoSettingsNusa, KC = window.KodaCatalog, KL = window.KodaLogic;
  if (!M || !KC || !KL || window.__settingsNusaLoaded) return;
  window.__settingsNusaLoaded = true;
  const { CATALOG, SHEETS } = KC;
  const lay = M.spriteLayout(), sheet = SHEETS[lay.cell];
  const now = () => performance.now();
  const reduced = () => doc.documentElement.dataset.motion === 'reduce' || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const block = doc.createElement('div'); block.className = 'nusa-koda';
  const veil = doc.createElement('div'); veil.className = 'nusa-veil'; veil.setAttribute('aria-hidden', 'true');
  const sprite = doc.createElement('div'); sprite.className = 'nusa-sprite'; sprite.setAttribute('aria-hidden', 'true');
  const voice = doc.createElement('p'); voice.className = 'nusa-voice'; voice.setAttribute('aria-live', 'polite');
  block.append(veil, sprite, voice);
  const st = sprite.style, px = lay.px;
  st.width = st.height = px + 'px';
  st.backgroundImage = `url(${sheet.file})`;
  st.backgroundSize = `${sheet.w * lay.k}px ${sheet.h * lay.k}px`;

  let mood = 'respirar', t0 = now(), agent = { name: '', hex: '' }, page = null;
  const setMood = id => { if (CATALOG[id] && id !== mood) { mood = id; t0 = now(); } };
  function paintVeil() { block.style.setProperty('--nusa-veil', M.agentVeil(agent.name, agent.hex)); }

  function apply(id) {
    const v = M.pageVoice(id);
    page = id; voice.textContent = v.phrase; setMood(v.mood);
    block.dataset.page = typeof id === 'string' ? id : '';
  }
  function activePage() {
    const on = doc.querySelector('#hub .hub-side .hub-item.on');
    return on ? on.dataset.page || null : null;
  }
  function sync() {
    const side = doc.querySelector('#hub .hub-side');
    if (!side) return;
    if (block.parentNode !== side) side.prepend(block);
    const id = activePage();
    if (id !== page) apply(id);
  }

  // the focused agent (settings has no live session state of its own): any module may publish {agent, color} here
  doc.addEventListener('abito:nusa-agent', e => {
    const d = (e && e.detail) || {};
    const AC = window.AbitoAvatarColors;
    const hex = typeof d.color === 'string' && AC && AC.normalizeChosenColor ? AC.normalizeChosenColor(d.color) || '' : '';
    agent = { name: typeof d.agent === 'string' ? d.agent : '', hex };
    paintVeil();
  });

  function frame() {
    requestAnimationFrame(frame);
    const el = now() - t0;
    if (!CATALOG[mood].loop && KL.isDone(mood, el)) setMood('respirar');
    const f = KL.frameAt(mood, now() - t0, reduced());
    st.backgroundPosition = `${-f * px}px ${-CATALOG[mood].row * px}px`;
  }

  // human comment 6 (29-oct): the install button reads «Instalar», no ellipsis. The label is vendor-produced (hub/agents.js «Install…»),
  // so it is rewritten here: only a button whose whole text is exactly «Instalar…» / «Instalar...»; node, handlers and ids stay;
  // idempotent (writes only when different, so its own write never re-triggers a change).
  const INSTALL = /^Instalar(…|\.\.\.)$/;
  function fixInstall(root) {
    for (const b of root.querySelectorAll ? root.querySelectorAll('button') : []) {
      const t = b.textContent || '';
      if (INSTALL.test(t.trim()) && b.childNodes.length === 1 && b.firstChild.nodeType === 3) b.firstChild.data = 'Instalar';
      const a = b.getAttribute('aria-label');
      if (a && INSTALL.test(a.trim())) b.setAttribute('aria-label', 'Instalar');
    }
  }
  const panel = doc.getElementById('hub'); // .hub-panel is built after load, so observe its stable parent
  if (panel) { fixInstall(panel); new MutationObserver(() => fixInstall(panel)).observe(panel, { subtree: true, childList: true }); }

  paintVeil();
  const hub = doc.getElementById('hub');
  if (hub) new MutationObserver(sync).observe(hub, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  sync();
  const img = new Image(); img.src = sheet.file;
  requestAnimationFrame(frame);
})();
