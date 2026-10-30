'use strict';
/* HU-063 T1 «Ajustes · sidebar Koda» (design/hu-060-ajustes-avisos/02-sidebar-koda.html). Pure view-model, no DOM, no IPC:
   page id -> {phrase, mood} (mood = a Koda animation id), the veil colour of the focused agent and the sprite layout (32 px sheet, x3).
   The browser mount lives in settings-nusa-mount.js. Classic script (window.AbitoSettingsNusa) and test-node module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSettingsNusa = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const v = (phrase, mood) => Object.freeze({ phrase, mood });
  // Hub page ids (vendor shell.js ACTIVE_PAGES) + the T2 «Isla» page. Spanish rioplatense, short.
  const VOICES = Object.freeze({
    general: v('Todo a tu medida', 'saludar'),
    agents: v('¿Quién trabaja en la isla? Vos mandás.', 'trabaja'),
    chat: v('Con tus claves, yo te escucho.', 'escucha'),
    shortcuts: v('¿Y esta tecla? ¡Ah, mirá!', 'curioso'),
    privacy: v('Nada sale sin tu permiso. Lo juro.', 'timido'),
    island: v('¡Probá un tamaño! Yo me acomodo.', 'jugueton'),
    isla: v('¡Probá un tamaño! Yo me acomodo.', 'jugueton'), // the rail id of the «Isla» page (settings-isla-mount.js)
  });
  const has = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(VOICES, id);
  const pageVoice = id => (has(id) ? VOICES[id] : VOICES.general);

  const DEFAULT_VEIL = '#4d9fff';
  const AGENT_VEIL = Object.freeze({ pi: '#2dffac', 'claude-code': '#b04dff', 'claude code': '#b04dff', claude: '#b04dff', codex: '#f472b6' });
  const HEX = /^#[0-9a-fA-F]{6}$/;
  // A valid human hex (already validated against the palette by AbitoAvatarColors in the mount) wins; otherwise the agent's own colour.
  function agentVeil(agent, chosenHex) {
    if (typeof chosenHex === 'string' && HEX.test(chosenHex)) return chosenHex.toLowerCase();
    const key = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(AGENT_VEIL, key) ? AGENT_VEIL[key] : DEFAULT_VEIL;
  }

  // Koda x3 on the 32 px sheet: integer scale only (never a fraction), 96 px.
  const spriteLayout = () => ({ cell: 32, k: 3, px: 96 });

  return { VOICES, pageVoice, agentVeil, spriteLayout, DEFAULT_VEIL };
});
