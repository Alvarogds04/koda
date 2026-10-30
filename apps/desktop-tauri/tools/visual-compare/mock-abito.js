// Abito side: the real frontend over the mocked host. The host snapshots below follow the
// shapes island.js / notify-view.js / spotify-view.js / sessions-ticker.js validate.
(() => {
  const fix = window.__VC_FIX;
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const st = {
    snapshot: { state: 'compact', revision: 1, connections: 1, notices: [], card: null, request: null, motionOverride: true, available: true },
    question: { available: true, pending: null, notice: null, revision: 1 },
    sessions: { truncated: false, rows: [] },
    prefs: { sound: true, gain: 0.12, autoCloseSeconds: 15, openOnHover: false, monitor: 'primary', mainPill: 'integration_claude', declaredPills: [], pillColors: {}, avatarColors: {}, theme: 'dark', motionOverride: true },
    spotify: { running: true, track: null, playing: false },
  };
  // The settings window starts from the same state Coucou's mock boots with (sound off, the four default pills
  // declared, weekly recap on), so the settings pages measure layout and not data. The island keeps its own defaults.
  const winLabel = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (winLabel === 'settings') Object.assign(st.prefs, { sound: false, declaredPills: ['integration_resend', 'integration_n8n', 'integration_vercel', 'integration_github'] });
  window.__vcAbito = st;
  window.__VC_INVOKE = (cmd, args) => {
    const p = args.payload || {};
    switch (cmd) {
      case 'desktop_action': return st.snapshot;
      case 'question_action': return st.question;
      case 'prefs_action': return st.prefs;
      case 'hotkey_action': return { enabled: true, combo: 'Ctrl+Alt+A', status: 'active', default: 'Ctrl+Alt+A' };
      case 'spotify_action': return { ok: true, state: st.spotify };
      case 'agent_action': if (p.action === 'sessions_list') { window.__vcPolled = (window.__vcPolled || 0) + 1; return { sessions: st.sessions }; } return { connection: 'connected', accounts: [], providers: [], agents: [
        // Same agents and states as mock-coucou.js (hooks_status / agent_hooks_list): Claude Code and Codex installed.
        { id: 'claude-code', state: 'connected', backup: true, reviewable: true },
        { id: 'codex', state: 'connected', backup: true },
      ] };
      // Same empty state Coucou shows: its flow_* commands are unmocked there (defaults), so dictation is off, no model, no data.
      case 'dictation_action': {
        const zero = { words: 0, seconds: 0, dictations: 0, wordsPerMinute: 0, minutesSaved: 0 };
        switch (p.action) {
          case 'status': return { prefs: { enabled: window.__VC_DICTATION === true, key: 'right_ctrl', edge: 'bottom', mic: '', keepDays: 30, cleanup: false, defaultStyle: 'natural', summaryEngine: 'off', openAtLaunch: false, voice: false, voiceOutput: 'off', voiceGender: 'female' }, models: { parakeet: { state: 'missing' }, downloadMb: 700 }, keys: 'ok', hasClaudeKey: false, mics: [], platform: 'linux', autostarted: false };
          case 'history': case 'snippets': case 'styles': return [];
          case 'words': return { words: [], replacements: [] };
          case 'stats': return { week: zero, month: zero, all: zero, daily: [], apps: {}, streak: 0 };
          default: return { ok: true };
        }
      }
      case 'recap_action': return p.action === 'prefs' ? { enabled: window.__VC_RECAP_AUTO === true, hideProjects: false, lastShownWeek: '' } : p.action === 'view' ? window.__vcRecapHistory() : { ok: true };
      case 'github_action': { const g = window.__vcGithub(); return p.section === 'activity' ? { available: true, fetched: true, activity: g.activity } : { available: true, fetched: true, pulse: g.pulse }; }
      case 'plan_action': return p.action === 'claude'
        ? { available: true, updatedAt: Date.now(), fiveHour: { usedPct: 42, resetsAt: Date.now() + 3600e3 }, sevenDay: { usedPct: 61, resetsAt: Date.now() + 86400e3 } }
        : { available: true, rateLimits: { primary: { usedPercent: 7, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowDurationMins: 300 }, secondary: { usedPercent: 33, resetsAt: Math.floor(Date.now() / 1000) + 86400, windowDurationMins: 10080 } } };
      case 'specialists_action': return { specialists: [], roles: [], active: null };
      case 'settings_window_action': return { ok: true };
      case 'secret_action': return { present: false };
      case 'daemon_action': return { ok: true };
      case 'chat_action': return { turns: [], active_turn: null };
      case 'models_action': return { available: false, models: [] };
      case 'record_frontend_evidence': case 'drag_press': case 'drag_move': case 'drag_release': return null;
      default: return undefined;
    }
  };
  // Applies a scenario: replaces the pieces and pushes them as the host would.
  window.__vcAbitoSet = (scn) => {
    const { snapshot, ...rest } = scn;
    Object.assign(st, rest);
    st.snapshot = { ...st.snapshot, revision: st.snapshot.revision + 1, ...(snapshot || {}) };
    window.__vcEmit('desktop:state', st.snapshot);
    window.__vcEmit('question:state', st.question);
    window.__vcEmit('prefs:state', st.prefs);
    if (st.spotify) window.__vcEmit('spotify:state', st.spotify);
  };
  window.__vcAbitoUuid = uuid;
  // The tauri global the frontend prefers (withGlobalTauri).
  const I = window.__TAURI_INTERNALS__;
  window.__TAURI__ = {
    core: { invoke: I.invoke },
    event: { listen: async (event, cb) => {
      const id = I.transformCallback(cb);
      await I.invoke('plugin:event|listen', { event, handler: id });
      return () => {};
    } },
  };
})();
