// Coucou side: the real app (settings.html / dev compare page) over the mocked IPC.
(() => {
  const fix = window.__VC_FIX;
  const screen = { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
  window.__VC_INVOKE = (cmd, args) => {
    switch (cmd) {
      case 'boot': return { settings: { mochiOutfit: 'none', soundEnabled: false, ...(window.__VC_SETTINGS || {}) }, screen, version: '0.5.0', hookPath: '/tmp/coucou-hook', cursorPoll: true };
      case 'fit_zoom': return false;
      case 'hooks_status': return { installed: true, path: '/home/dev/.claude/settings.json', detail: '' };
      case 'agent_hooks_status': return { codex: true };
      case 'agent_hooks_list': return [
        { id: 'codex', name: 'Codex', installed: true, available: true, path: '/home/dev/.codex/hooks.json' },
      ];
      case 'list_monitors': return [{ key: 'primary', label: 'Primary' }];
      case 'custom_sounds': return [];
      case 'phone_link_status': return { enabled: false, running: false, port: 0, host: '', name: 'Desk', clients: 0, error: null, relayState: 'off' };
      case 'spotify_refresh': return null;
      case 'recap_history': return window.__vcRecapHistory();
      case 'recap_prefs': return { enabled: true, hideProjects: false, lastShownWeek: '' };
      case 'github_refresh': return null;
      case 'pill_state': return { phase: 'locked', edge: 'bottom', key: 'right_ctrl', noteStartedAt: null, announcement: null, enabled: true, voice: null };
      case 'flow_status': return { platform: 'linux', prefs: { enabled: true } };
      case 'secret_present': return true;
      default: return undefined;
    }
  };
})();
