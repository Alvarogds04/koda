'use strict';
/* window.desktop — the M1b host facade over Tauri invoke/events.
   Same verbs, same promise results, same snapshot shapes as the Electron
   preload (preload.cjs): no raw IPC objects, no channel selection, no
   arbitrary arguments — `choose` carries an integer index and nothing else.
   Every call goes through the single `desktop_action` command, which
   re-validates sender, payload shape and rate on the Rust side.
   Rejections are typed objects { code, message }:
   - `denied`        — Electron's `Denied` (with the reason attached), also
     the answer of `choose` while no request stands (M3),
   - `rate-exceeded` — Electron's `Rate exceeded`.
   Since M3, `allow`/`deny`/`choose` are wired: the WebView sends only the
   human's choice and Rust re-validates card id, expiry and payload_hash
   before any `/execute`; the cookie never exists on this side of the IPC. */
(() => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;

  // #366 F093: the settings window never gets the island-driving facade.
  const __label = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
    && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  if (!window.desktop && invoke && __label !== 'settings') {
    const action = name => invoke('desktop_action', { payload: { action: name } });
    window.desktop = Object.freeze({
      snapshot: () => action('snapshot'),
      expand: () => action('expand'),
      close: () => action('close'),
      hide: () => action('hide'),
      quit: () => action('quit'),
      // #437: argument-free = the FIRST notice goes (M2, unchanged); with an
      // exact notice id, EXACTLY that notice goes — Rust validates it and
      // refuses an unknown one with zero mutation, never a fallback.
      dismiss: id => (id
        ? invoke('desktop_action', { payload: { action: 'dismiss', id } })
        : action('dismiss')),
      // Display-only opener. Rust validates the exact UUID/kind and current host identity.
      /** @param {{id: string, kind: 'question' | 'finished'}} notice */
      click: ({ id, kind }) => invoke('desktop_action', { payload: { action: 'click', id, kind } }),
      allow: () => action('allow'),
      deny: () => action('deny'),
      // The renderer sends an INDEX, never the chosen text: it is the most
      // exposed part of the app; main decides what the third one is.
      choose: index => invoke('desktop_action', { payload: { action: 'choose', index } }),
      // Motion override: two fixed zero-argument verbs, never a
      // setMotionOverride(bool). Each answers with the fresh snapshot.
      animateAnyway: () => action('animateAnyway'),
      respectSystemMotion: () => action('respectSystemMotion'),
      // #336: the island's inactivity close. Argument-free like `close`; the
      // atomic protected-state admission lives entirely on the Rust side and
      // the legacy explicit `close()` contract is untouched.
      autoClose: () => action('autoClose'),
      onState(callback) {
        if (typeof callback !== 'function') throw new TypeError('Callback required');
        if (!listen) return () => {};
        let dead = false;
        let unlisten = null;
        const handler = event => {
          if (!dead && event && event.payload !== undefined) callback(event.payload);
        };
        listen('desktop:state', handler).then(
          fn => { if (dead) fn(); else unlisten = fn; },
          () => { /* no listener: snapshot() remains the pull path */ }
        );
        return () => {
          dead = true;
          if (unlisten) { unlisten(); unlisten = null; }
        };
      },
    });
  }
})();
