# Abito island — Electron → Rust + Tauri, units M1b (host/bridge) + M2 (Pi transport) + M3 (approval lane)

Skeleton of the Abito desktop island as a normal Cargo project with Tauri v2
(`tauri-build` in `build.rs`, static `frontendDist`, **no npm, no
node_modules, no cargo-tauri CLI**). Transparent, undecorated, always-on-top
X11 window hosting Abito's own R7 clay character with free drag and edge docking.

## R7 character states (#347)

The seven R6 public names/order and existing looks remain, with eight own clay states appended
(15 total). Real pending approvals/questions outrank active chat, existing errors, a neutral
1800 ms new-turn-finished presentation, and 60 s idle sleep. Sending a decision is never success.
`working/searching/ratelimit` are preview-only until real producers exist. #304's explicit
opt-in system-motion preference remains; honored reduction shows the correct static pose.
See [state/producer contract](../../docs/r6-states-mapping.md) and the coordinator-owned T6
native evidence gate. No Mochi assets/design/sounds, new dependencies or native drag edits.

Focused check: `node test-node/character-states-check.cjs`. Debug-only browser preview:
`tests/character-preview.html` (not shipped); use its manual next-frame control or each static pose.
Node tests are not native clipping, motion/CPU or real producer-roundtrip proof.

Unit **M1b** adds the host/bridge layer on top of the M1a skeleton: the
`window.desktop.*` facade over Tauri invoke/events, the Electron validation
gate ported to Rust with unit tests, lifecycle (single instance, work-area
re-clamp, clean quit), a least-privilege capability and a strict CSP.

Unit **M2** adds the Pi → desktop notice transport: the Unix-domain-socket
receiver ported from `transport.cjs`/`core.cjs` with the SAME wire format and
limits, tested first (RED → GREEN) and integration-tested over real sockets,
the now-wired `dismiss` verb, and display-only Sileo-style notice text in the
island. The Node producer (`pi-extension.ts`/`adapter.cjs`) is unchanged.

The least-privilege capability (`capabilities/main.json`) covers both native
webviews: `"main"` (the island) and `"settings"` (created in Rust by
`src/settingswindow.rs`). Both get exactly two permissions —
`core:event:allow-listen` and `core:event:allow-unlisten` — so the settings
window can subscribe to live state events; everything else stays denied. The
packaging gate pins the exact window list and permission set
(`packaging/lib.cjs`, `EXPECTED_WINDOWS`/`EXPECTED_PERMISSIONS`).

Unit **M3** ports the approval lane — Electron's `main.cjs` HTTP authority —
to Rust: the `bridge.json` credential read, the in-memory session cookie, the
5 s-deadline HTTP client with manual redirects and abort-on-quit, the
"only known rejected requests may be retried, never a network failure"
auth ladder, polling (health + proposals), the pinned proposal card, and the
wired `allow`/`deny`/`choose` verbs. The WebView only ever sends the human's
click; Rust re-validates card id, expiry and `payload_hash` before `/execute`.

## Blob catalog (#345, F031/F032)

The [blob model](../../docs/pills.md) contains 25 stable identities, one main
workspace choice and up to four declarations. Choices are local, explicitly
**not connections**; services remain unavailable without a real producer.
Run `node apps/desktop-tauri/test-node/pill-catalog-check.cjs` from the repo root
for the offline model checks; `node apps/desktop-tauri/test-node/pills-check.cjs`
executes the actual overview/settings scripts against a local fake DOM/IPC.
Use **Ajustes → Blobs** to set the main and declare/remove choices. The overview
shows main plus declarations in catalog order and keeps its existing host
connection, notices and decision controls. Per-blob colour overrides are
documented in the next section (#346). The UI copy calls these choices
**blobs** (the main one is the blob principal); the stored keys, wire fields,
file names and test ids keep their shipped `pill` names (#415).

## #346 — per-blob colours (F033 palette override)

Every visible blob may wear one of the five palette colours, chosen by the human
in **Ajustes → Blobs**. The mechanism is closed end to end and the model lives
with the rest of the blob docs in [docs/pills.md](../../docs/pills.md).

- **One vocabulary, no raw values.** The only accepted colours are the five names
  `green | blue | mint | orange | purple`: `COLORS` in `src/prefs.rs` and
  `PALETTE` in `frontend/avatar-colors.js` — the same set the Dot uses. No hex,
  rgb, CSS text or user string is ever stored, transported or painted; the model
  answers only an already-validated name or the empty string (`colorOf`).
- **Typed field.** `prefs.json` gains an optional `pill_colors` map
  (blob id → palette name). Unknown blob ids and off-set colours drop on load —
  the `main_pill` reading rule mirrored — and absent or empty never writes the
  key, so untouched files keep their bytes and a hostile value can never destroy
  the stored catalogue or any other known field.
- **Two closed commands.** `{"action":"set_pill_color","id":"agent_amp","color":"purple"}`
  (exactly three keys) and `{"action":"clear_pill_color","id":"agent_amp"}` (exactly
  two). Both validate the offered catalog id and the palette name in
  `parse_command` and again in `apply`; wrong arity, an unoffered id (Apple Music,
  Claude Desktop on Linux), a sixth name, `""`, a prototype key or a non-string is
  `invalid_schema` with no persistence and no publication.
- **Projection.** The `prefs_action` view and the `prefs:state` event carry
  `pillColors` beside `avatarColors`: already-validated names only, nothing new or
  sensitive crosses the wire.
- **UI.** Each offered row in **Ajustes → Blobs** gets a closed select with the
  five colour names plus a selectable **Sin color**, which dispatches
  `clear_pill_color` — the escape hatch the avatar does not need, because there
  the default is itself one of the five while a colourless blob must stay
  reversible. The overview paints `data-color` only from the validated name, and
  `style.css` maps the five names to the never-themed `--dot-*-2` identity tokens
  as borders: both #380 palettes show the same colour, hover/pressed blob rules
  stay untouched, and the blob keeps its name text and aria — colour never
  carries meaning alone.
- **Checks.** `pill-catalog-check.cjs` and `pills-check.cjs` pin the model gates
  and the DOM/event boundary (set/clear writes, hostile values never paint);
  `settings-view-check.cjs`, `theme-check.cjs` and `avatar-colors-check.cjs` stay
  green as regression evidence; `sound-wiring-check.cjs` pins the `pillColors`
  DTO shape beside `avatarColors`; `cargo test --lib f033_` (from
  `apps/desktop-tauri`) pins catalogue survival, arity and field isolation. Only
  a human on a real preview can prove legibility of each colour on both palettes.

## #415 — the human reads «blobs»; creatable blobs (WU1/WU2)

Every visible word the UI speaks is **blob** (Ajustes tab «Blobs», «Blob
principal», notes, toasts, overview aria): WU1 renamed the copy only — the
stored keys (`main_pill`, `declared_pills`, `pill_colors`), wire fields, closed
actions, file names and test ids keep their shipped `pill` names, pinned by
`blobs-copy-check.cjs`.

WU2 lets the human create additional named blobs (e.g. «Abito GitHub»,
«Abito Reviewer», «Abito correo») in **Ajustes → Blobs → Tus blobs**. A created
blob is a label + optional #346 palette colour entry, in creation order — no new
agent behaviour, choosing never connects anything. The principal «Abito» is the
main blob: it can never be created or deleted.

- **Typed field.** `prefs.json` gains an optional `custom_blobs` list of
  `{name, color?}` — absent from a file nobody created a blob in, so untouched
  files keep their bytes. Names are bounded plain text (≤40 scalars, trimmed,
  no controls, never «Abito», unique case-insensitively, at most eight blobs);
  colours are `COLORS` names only; hostile stored entries drop on load like
  every hostile input.
- **Three closed commands.** `create_blob` (action + name + optional colour),
  `delete_blob` (action + name) and `set_blob_color` (action + name + colour or
  `""` to clear). The model gates mirror them pure (`createBlob`, `deleteBlob`,
  `setBlobColor` in `frontend/pills.js`): a refused write returns null and
  mutates nothing.
- **Projection.** `prefs_action` and `prefs:state` carry `customBlobs`
  (validated names + palette names or null); the overview renders them after
  the catalog order as label+colour buttons.
- **Relation to #327 specialists.** Specialists are CHAT roles (name +
  instructions + model, own `specialists.json` store and command set); blobs
  are overview/settings entries in `prefs.json`. No shared storage, no shared
  commands — only the same validation philosophy (bounded plain name, reserved
  principal identity refused).
- **Checks.** `pills-check.cjs` drives the real scripts: model gates (the three
  human examples accepted, duplicates/principal/cap refused without change),
  overview render, Ajustes create/delete/colour dispatch through the closed
  commands, synthetic-gesture refusals and failed-save recovery;
  `cargo test --lib prefs::` + `settingshost::settings_view_tests::f415_` pin
  round trips, byte preservation, hostile drops and the projection.

## Validador de pantalla y puerta de preview (#502)

**Antes de entregar una preview, usar esta puerta** desde `apps/desktop-tauri`:

```sh
node packaging/preview.cjs --out /tmp/abito-preview-nueva
# Repetir sin recompilar la variante de validación, sólo si sus fuentes no cambiaron:
node packaging/preview.cjs --skip-build --out /tmp/abito-preview-otra
```

El destino debe ser nuevo y estar bajo `/tmp`; nunca se sobrescribe una preview.
Primero se ejecuta el validador. Si alguna escena falla, imprime el informe español,
sale con código distinto de cero y **no crea el destino ni ofrece un comando de
lanzamiento**. Si no hay fallos, Cargo reutiliza la compilación offline de producción
(sin `probe`), se rechazan marcadores de validación en el binario, se prepara una
preview con sus helpers y se imprime su comando. No la inicia ni instala nada.
Esto es una preview de candidato con procedencia y huella en `preview.json`, **no un
paquete de distribución**: las puertas de árbol limpio y receipt de
`packaging/build.cjs` siguen intactas. Los scripts antiguos de desarrollo no son
esta puerta y no deben usarse para entregar una preview validada.

Para obtener sólo el informe y las capturas:

```sh
node packaging/validate.cjs
node packaging/validate.cjs --skip-build
node test-node/validate-gate-check.cjs
```

Requisitos locales: toolchain Cargo y dependencias ya disponibles offline, Node,
Xvfb, openbox, dbus-daemon, xprop, ffmpeg, Python 3 con Xlib y `/usr/bin/python3`
con PyGObject/Gio. Usar la configuración `SHERPA_ONNX_LIB_DIR` de la compilación
local. `--skip-build` rechaza binarios obsoletos por HEAD, huella de fuentes y hash.

### Qué demuestra

41 escenas con un PNG por escena e informe `report.json` y `probe.jsonl` en
`/tmp/abito-validate-*`. Cada línea dice **anda**, **falla (motivo)** o
**no verificable aquí (motivo)**. La última categoría no se cuenta como éxito ni
bloquea por sí sola la puerta; una escena ausente, un error de consola o una captura
ausente sí la bloquean.

| Área | Evidencia |
| --- | --- |
| Isla | Compactar, expandir, minimizar por clic y ocultar/mostrar sobre una ventana rival; siempre encima. |
| Chat y Pi | Dos turnos con modelo HTTP falso; snapshot tardío; sesiones, etiqueta de conexión, aviso y respuesta a pregunta por el socket real. |
| Ajustes | Engranaje público y las 15 páginas; controles reales y efectos observados. |
| GitHub | `gh` privado en PATH llama a un HTTP falso loopback; dato recibido y pill visible exigidos, nunca una cuenta real. |
| Spotify | MPRIS falso en el bus privado; título y estado en pantalla, dos clics play/pausa que llegan al falso. |
| Sonidos | `sound_action` list/reload y recepción de `sounds:changed`, sin errores de consola. |
| Dictado y voz | Estado de modelos ausentes y botón Descargar en sus páginas de Ajustes; no se descargan modelos. |
| Bandeja y autoinicio | Menú D-Bus real: Mostrar/Ocultar, cuatro opciones; toggle escribe y retira `.desktop` privado con `Name=Abito`. No pulsa Salir. |
| Personaje | Salida/regreso por los comandos compartidos con el toggle; ventana visible encima y luego oculta. |

El validador usa **otra pantalla Xvfb, nunca `DISPLAY=:0`**, con WM, bus D-Bus,
HOME y XDG privados. Los sockets Pi viven sólo en
`/run/user/1000/abito-validator-pi/<aleatorio>` (0700, retirado al terminar);
no toca `/run/user/1000/abito-island`. Los clics XTest pertenecen al proceso de
validación, nunca al binario entregado. El atajo comprueba el callback compartido,
no la entrega física de teclas por GNOME; el menú se activa por su exportación
D-Bus, no por un panel GNOME.

### Qué significa «no verificable aquí»

- **Correo y cuentas:** no hay keyring privado. Se exige la respuesta honesta
  `keychain_unavailable`; no se leen claves reales ni se afirma que IMAP/SMTP funcionen.
- **Audio audible:** list/reload no demuestra que una persona oye el sonido.
- **Reconocimiento y micrófono:** sin modelos ni micrófono privado no se demuestra
  transcripción, wake word ni voz hablada. El portal de GNOME y la integración
  con su panel requieren una sesión de escritorio real.
- **Notas y teléfono:** la página se comprueba, pero sus controles están deshabilitados
  por el producto y no se atribuye funcionamiento a esas capacidades.

Un fallo real del producto permanece rojo con PNG y motivo; no se rebaja a
«no verificable» para entregar la preview. Por ejemplo, una pill declarada que no
aparece pese a recibir datos del servicio falso bloquea la puerta.

## HU-015 — Ajustes → Agentes without the engine (daemon-free hook route)

Each agent row (Claude Code, Codex, OpenCode, Copilot CLI, recap, status-line relay) depends only on **its own hooks**.
Pi and the daemon are not involved: with no Pi (or no daemon) Claude Code and Codex are listed, installable and removable.

- `agent_action` takes `agents_list`, `hooks_preview`, `agent_connect`, `agent_disconnect` in `src/agents_direct.rs`
  (the page never asks the daemon for these; one owner, no daemon/direct race). Validation is the existing closed grammar
  (`agentclient::parse_ui_command`: allowlisted id, 64-hex plan hash).
- Rust runs the bundled `desktop-daemon/src/agents-direct.cjs` with node (`daemonhost::discover("node")`; script beside the
  installed daemon; never PATH/CWD/page paths; no shell; cleared environment). It drives the same `AgentsManager`
  (preview → human confirm → plan-hash check → backup → apply → audit) and prints two closed frames, folded by
  `agentclient::fold_direct` into `directAgents` / `directHooks` / `agentsRuntime`.
- Bounds: 60 s, 512 KiB of stdout, whole process tree killed on timeout, oversize, or a descendant keeping stdout open.
- Missing Node.js reads «Falta Node.js» on each row (hooks are Node scripts); a failed run reads «No se pudo». Never «Falta Pi»
  on this screen. The chat/engine diagnostics (`connectionView`) are unchanged.

## Run

```sh
./run.sh                                # exports GDK_BACKEND=x11, runs `cargo run`
# or directly:
cargo run --manifest-path apps/desktop-tauri/Cargo.toml
# needs a display, e.g.:
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 ./run.sh
```

`main()` also forces `GDK_BACKEND=x11` when the variable is unset (before GTK
initialises), because the launcher alone cannot cover every entry point.

## Read-back probe

```sh
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 timeout 120 cargo run
# (equivalent: cargo run -- --probe)
```

The probe runs the scripted sequence **start → simulated drag near the bottom →
release/snap → expand → collapse → drag to the top → facade evidence →
frontend evidence → transport evidence → approval evidence** and,
after each step, waits for the window manager to apply, then prints one JSON
line per step with:

- `actual`: the real getters — `outer_position`, `inner_size`, `scale_factor`,
  `is_always_on_top`, `is_decorated`, `work_area` (+ `work_area_source`), and
- `requested`: the values Rust asked for, plus `match.position` / `match.size`
  so any discrepancy is visible in the line itself,
- every line carries `"pointer_input": "… the probe drives the same core
  handlers programmatically; no real pointer events are used"` — the probe
  never synthesises input events, it calls `Core::press/drag/release/toggle`,
  the exact handlers the webview's pointer commands call.
- the `frontend_evidence` line reports the SVG element count rendered by
  clay-engine and the canvas count (must be 0 — R6 is SVG-DOM),
- the `facade_evidence` line (M1b) is produced by the webview itself through
  the real `window.desktop` / `desktop_action` path: the 12 preload verbs,
  the snapshot returned by `snapshot`/`expand`/`close`, one typed rejection of
  an invalid call, a 40-call rate-limit burst with its typed rejections,
  `onState` event deliveries, and the `webview_label` / `webview_url` the
  command-side sender gate actually sees,
- the `transport_evidence` line (M2) is the probe acting as the Pi producer
  against the receiver this process owns: one `hello` frame, the byte-exact
  `ready` line, one `settled` frame, then `notice_count` read back through
  the REAL snapshot path, with `connections_while_connected` →
  `connections_after_disconnect`. `preview_roots_detected_only` lists the
  installed Preview's reserved socket roots READ-ONLY — detected and
  reported, never connected, never unlinked (an `ABITO_SOCKET_DIR` override
  keeps the probe in its own directory).

Exits only this app (`std::process::exit(0)`).

## Read-back findings (observed, not hidden)

The probe prints Tauri's getters (`actual.*`) **and** raw X11 truth
(`actual.x11_window`, `match_x11.*`). On this stack (Ubuntu 26.04, GNOME
Wayland + XWayland, Tauri 2.12.1, GTK 3.24.52, WebKitGTK 2.52.6):

1. **Placement is exact at the X-server level**: every `match_x11.position`
   and `match_x11.size` is `true` — start top-centre `[831,32]`, drag + snap
   bottom `[934,1036]` (chosen X kept), expand bottom-anchored `[750,904]`
   (904+176 = work-area bottom: grows upward), collapse back to `[934,1036]`,
   drag + snap top `[934,32]`. All sizes land exactly 288x32 (Coucou's bar since L34; it was a 44x44 disc, and 304x44 before #302) / 672x208.
2. **Tauri's `outer_position` getter reports a constant Y offset of −37px**
   (X is correct, setters are correct). The drag math therefore reads the
   origin from the X server (`workarea::x11_window_origin`); the getter
   artifact stays visible in `actual.outer_position`, so `match.position`
   remains `false` on purpose — that is the discrepancy, reported not hidden.
3. **`is_always_on_top()` returns `false` while X11 reports
   `_NET_WM_STATE_ABOVE` set** (`net_wm_state_above: true` at every step):
   the window really is above others; the getter does not reflect it.
4. **WebKitGTK inflates the very first map** (it was 304x81 instead of 304x44
   for the old pill; the compact window is now 288x32) and
   a plain `set_size(78,78)` is refused until the widget has been grown
   once. The app pins the contract geometry after page load with a silent
   height-only grow→shrink (the island is top-anchored and the width does not
   change, so nothing moves on screen); the probe waits for that settle
   before the `start` readback. The pin aborts on the first real pointer
   press or toggle.
5. **Monitor geometry is unusable before the window is mapped under
   XWayland** (`work_area_monitor_raw: null`); the clamp uses
   `_NET_WORKAREA = [47,32,1873,1048]` (Ubuntu left dock + top bar),
   intersected with the monitor when the latter is valid.
6. Frontend evidence line: `svg_elements_rendered_by_clay_engine: 18`,
   `canvas_elements: 0`, `clay_revision: "R6"`.

## What M1b proves (and what it does not)

Proven by the probe's `facade_evidence` read-back through the REAL webview
IPC path (observed 2026-10-09, this stack):

- **Facade**: `window.desktop` carries exactly the preload.cjs verb list —
  `snapshot, expand, close, hide, quit, dismiss, allow, deny, choose,
  animateAnyway, respectSystemMotion, onState` (`verbs_match_preload: true`).
- **Snapshot shape**: `snapshot`/`expand`/`close` return the exact 13-key
  Electron snapshot (`revision, state, view, anchor, request, motionOverride,
  branding, connections, unavailable, notices, bridgeStatus, card`), e.g.
  `{"revision":4,"state":"expanded","view":"island","anchor":"top",…}`.
- **Rejected invalid call**: `{"code":"denied","message":"Denied: unknown
  action"}` for an action outside the closed set.
- **Rate limit**: 40 concurrent valid calls → 10 rejected with
  `{"code":"rate-exceeded","message":"Rate exceeded"}` (30 per fixed 1 s
  window; validation runs before the gate, so invalid calls cost no budget).
- **Sender gate**: the command saw `webview_label: "main"` and
  `webview_url: "tauri://localhost"` — the exact allowlist entries in
  `bridge::page_url_allowed` (label/URL checked on every call).
- **Events**: `onState` received `desktop:state` deliveries with monotonic
  revisions (`state_events`, `last_event_revision` in the evidence line).
- **CSP**: all of the above runs under the strict CSP in `tauri.conf.json` —
  evidence arrived, so scripts/events/IPC work without `unsafe-eval` and
  without any inline script or style (index.html contains none; nothing to
  justify).
- **No M1a regression**: every geometry step still reports
  `match_x11.position/size: true` (78x78 / 672x176; 304x44 before #302, snap keeps X, expand
  grows upward at the bottom) and `clay_revision: "R6"`, canvas 0,
  `clay-engine.js` sha256 unchanged.

### Verb mapping (Electron → Tauri)

| preload.cjs verb | Tauri path | status |
|---|---|---|
| `snapshot()` | `desktop_action {action:"snapshot"}` | wired — returns the 13-key snapshot |
| `expand()` | `desktop_action {action:"expand"}` | wired — same funnel as the short click (core toggle → apply_plan) |
| `close()` | `desktop_action {action:"close"}` | wired — collapses from expanded, no-op otherwise (Electron `transition`) |
| `hide()` | `desktop_action {action:"hide"}` | wired — window hide, state `hidden` |
| `quit()` | `desktop_action {action:"quit"}` | wired — clean exit through `RunEvent::Exit` |
| `dismiss()` | `desktop_action {action:"dismiss"}` | wired (M2) — drops the FIRST notice (id + sessionId, `main.cjs:461` semantics), publishes and returns the fresh snapshot; a dismissal never approves or decides anything. #373: while a transport-failure notice is present it leads the queue, so this dismisses exactly that failure event (see «Transport failures are notices too») |
| `allow()` / `deny()` | `desktop_action {action:"allow"\|"deny"}` | **wired (M3)** — the explicit human choice; the lane re-validates card id/expiry/`payload_hash` host-side, then `POST /api/proposals/{id}/execute` (body `{"payload_hash":…}`) or `/reject`. Returns the fresh snapshot; the outcome lives in the sticky card reason (`Decisión enviada.` / `No se pudo confirmar la decisión.`) |
| `choose(index)` | `desktop_action {action:"choose",index}` | **wired (M3)** — read-and-consume of the standing request in one synchronous step; no producer of requests exists yet (same as legacy), so every choice answers the typed `denied` (`no standing request`) and nothing is consumed |
| `animateAnyway()` / `respectSystemMotion()` | `desktop_action …` | wired — one machine-wide `motionOverride`, persisted `motion.json` mode 0600, fail-closed read; the island animates only on an explicit `animateAnyway` snapshot |
| `onState(cb)` | `event listen "desktop:state"` | wired — Rust `publish()` with main.cjs dedupe + revision semantics |

### Validation gate (core.cjs67-76 + security.cjs + main.cjs), ported pure

`src/bridge.rs` (no window-system calls; tests written first, RED → GREEN):

- **payload**: size ≤ 512 B first, JSON object, `action` in the closed
  11-entry set, `choose` carries exactly one integer `index`, every other
  verb carries nothing else (a known action cannot smuggle a payload),
- **sender**: exact window label `main` + exact local page URL allowlist
  (`tauri://localhost`, `/`, `/index.html` — no prefix, query or fragment),
- **rate**: 30 calls per fixed 1 s window, rejected attempts keep consuming
  budget, validation runs BEFORE the gate (main.cjs order),
- rejections are typed `{code, message}` objects: `denied` (Electron
  `Denied`), `rate-exceeded` (`Rate exceeded`). No verb is `not-yet-wired`
  since M3 (that code remains in the error type, unused).

### Lifecycle, capabilities, CSP

- **Single instance** (`tauri-plugin-single-instance`, crates.io): a second
  launch hands its argv to the first instance, which restores (→ compact,
  clamp), shows and focuses the island; the second process exits before
  `Builder::run`. Observed: second instance exit 0 in 0.06 s, exactly one
  `abito-island` process remained.
- **Work-area re-clamp**: Tauri/Tao expose no display events, so
  `workarea::current` (same source Electron's `display-*` handlers used) is
  polled every second and a CHANGED rect re-clamps the window through the
  pure `geometry::clamp_rect` port of `clampBounds`; a live drag is never
  fought (the release snap owns geometry while pressed). The clamp itself is
  unit-tested; a live panel-move was NOT exercised (it would mean changing
  the user's GNOME setup — not done).
- **Clean quit**: `quit` verb, window close (`CloseRequested` →
  `prevent_close` + `app.exit(0)`), `RunEvent::Exit` releases the
  single-instance D-Bus name; the probe calls `single_instance::destroy`
  before `process::exit` so a later launch is never mistaken for a live one.
  SIGINT/SIGTERM handlers landed with M2: they run the same cleanup (socket
  first, then exit) — see *What M2 proves*.
- **Capabilities** (`capabilities/main.json`): `core:default` dropped; the
  webview may only `core:event:allow-listen` / `allow-unlisten`. Host actions
  go through the app's own commands, which Tauri gates by origin (a remote
  origin cannot reach them — enforced by Tauri's ACL, not by us).
- **CSP** (`tauri.conf.json`): `default-src 'self'` plus explicit
  `script-src/style-src/img-src/font-src 'self'`,
  `connect-src 'self' ipc: http://ipc.localhost` (Tauri IPC), `object-src
  'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`. No remote
  origins, no `unsafe-eval`, **no inline script or style at all** (the page
  has none, so no inline exception had to be justified).
- **Navigation**: the `navigation-lock` plugin cancels every top-level
  navigation not on the exact local app page (security.cjs `will-navigate`
  counterpart); no new-window handler is installed, so `window.open` /
  `target=_blank` create nothing.

Not in this unit (later sessions): packaging and replacement of the
installed Preview (M4, needs separate human authorisation). The UDS
transport receiver is no longer "later" — it landed in M2, below; the
approval HTTP lane landed in M3, below.

## What M2 proves (and what it does not)

**Same wire, same limits — parity table.** Legacy values come from the
committed read-only Electron source (`worktrees/legacy-electron/apps/desktop`),
Rust values from this crate; every rule is the same rule, not a
re-interpretation (the receiver tests were written first: RED → GREEN):

| contract | legacy value (file:line) | Rust value (file:line) |
|---|---|---|
| frame size cap | `frameBytes: 512` — `core.cjs:3` | `FRAME_BYTES = 512` — `src/protocol.rs:32` |
| freshness window (no future, no stale) | `freshMs: 15000` — `core.cjs:3` | `FRESH_MS = 15_000` — `src/protocol.rs:33` |
| notice expiry | `expiryMs: 60000` — `core.cjs:3` | `EXPIRY_MS = 60_000` — `src/protocol.rs:34` |
| notice queue bound | `queue: 8` — `core.cjs:3` | `QUEUE = 8` — `src/protocol.rs:35` |
| dedupe entries | `dedupe: 256` — `core.cjs:3` | `DEDUPE = 256` — `src/protocol.rs:36` |
| connection quota | `connections: 4` — `core.cjs:3` | `CONNECTIONS = 4` — `src/protocol.rs:37` |
| frame rate per connection | `framesPerMinute: 120` — `core.cjs:3` | `FRAMES_PER_MINUTE = 120` — `src/protocol.rs:38` |
| handshake deadline | `handshakeMs: 3000` — `core.cjs:3` | `HANDSHAKE_MS = 3_000` — `src/protocol.rs:39` |
| idle deadline (valid frames only) | `idleMs: 30000` — `core.cjs:3` | `IDLE_MS = 30_000` — `src/protocol.rs:40` |
| batch cap | `frameBytes * 8` — `transport.cjs:66` | `BATCH_FACTOR = 8` — `src/protocol.rs:43` |
| ready answer (byte-exact) | `'{"v":1,"type":"ready"}\n'` — `transport.cjs:81` | `READY_LINE` — `src/protocol.rs:48` |
| project id = sha256(realpath) | `core.cjs:5` | `project_id` — `src/protocol.rs:54` |
| session label / event id patterns | `core.cjs:6-7` | `session_token`/`token` — `src/protocol.rs:67,82` |
| frame decode + scope/identity checks | `decode` — `core.cjs:10-33` | `decode`/`validate` — `src/protocol.rs:156,212` |
| notice store (prune/dedupe/queue/dismiss) | `NoticeStore` — `core.cjs:35-60` | `src/protocol.rs:417` (`accept:441`, `snapshot:481`, `dismiss:488`) |
| line framing: split, tail gate | `transport.cjs:69,86` | `Framer::push` — `src/protocol.rs:323` |
| per-connection fixed-minute quota | `transport.cjs:73-75` | `FrameQuota::check` — `src/protocol.rs:379` |
| endpoint naming `<runtime>/p-XXXXXX/s` | `transport.cjs:49,114-115` | `mkdtemp` — `src/transport.rs:557` |
| dir chain: dir, no symlink, root/us, not world-writable | `directoryChain` — `transport.cjs:11-20` | `directory_chain` — `src/transport.rs:239` |
| private dir = exactly 0700 + ours | `transport.cjs:22-26` | `private_directory` — `src/transport.rs:266` |
| endpoint verify (shape/0600/uid/socket/no symlink) | `verifyEndpoint` — `transport.cjs:34-44` | `verify_endpoint` — `src/transport.rs:290` |
| socket chmod 0600 after bind | `transport.cjs:117` | `create_transport` — `src/transport.rs:664` |
| sockaddr_un ≤ 107 bytes | `transport.cjs:112` | `src/transport.rs:640` |
| handshake/idle timers, rate check before decode | `transport.cjs:60-61,74-75` | `handle_connection` — `src/transport.rs:801` |
| connections = handshaked clients only | `transport.cjs:57,82` | `Inner::report` — `src/transport.rs:426` |
| cleanup: dir+socket inode identity, foreign paths untouched | `transport.cjs:91-106` | `cleanup` — `src/transport.rs:508` |
| owner check | file uid + 0600 only — `transport.cjs:34-44` | `SO_PEERCRED` same-uid — `src/transport.rs:588` |
| `onNotice` gated by a store before the app | `transport.cjs:83` | `Inner.store` — `src/transport.rs:801` handler |
| `dismiss` drops the first notice | `main.cjs:461-463` | `main.rs:752` |
| transport wiring + callbacks + publish | `main.cjs:488-491` | `start_transport` — `main.rs:138` |
| `ABITO_DESKTOP_SOCKET=…` stdout line | `main.cjs:493` | `main.rs:182` |
| `unavailable = true` only when the receiver fails to start | `main.cjs:495-497` | `start_transport` — `main.rs:138` |
| cleanup refusal line on quit | `main.cjs:383-384` | `main.rs:108,119` |
| SIGINT/SIGTERM run the clean quit | `main.cjs:393` | `install_shutdown_handlers` — `main.rs:71` |

Deliberate, documented deltas (no wire change):

- **Owner check on the wire**: the legacy receiver trusted the 0600 socket
  file; the Rust receiver additionally requires the connecting peer's uid to
  be ours via `SO_PEERCRED` (otherwise the connection is dropped before it is
  counted). Strictly tighter admission, same protocol.
- **`Linux identity required`** (legacy fails closed when `process.getuid`
  is absent) has no Rust counterpart: `libc::getuid` always answers on
  Linux, so the branch cannot exist — documented, not silently dropped.
- **Reserved Preview roots**: `packaged.cjs` maps `com.abitog.Abito` →
  `/run/user/<uid>/abito-desktop`. This receiver REFUSES any runtime root
  that is or contains that directory or `…-preview`
  (`runtime_allowed`, `src/transport.rs:186`): it never binds, unlinks or
  connects there. Detection is read-only (`read_dir` + `lstat`, never a
  connect) and the probe only reports what those roots hold.

### Socket path contract (M2)

- Default runtime root: `apps/desktop-tauri/.runtime` — the dev layout
  `apps/desktop/.runtime` had — created 0700; endpoint
  `<root>/p-XXXXXX/s` (`XXXXXX` = six alphanumerics per launch), generated
  dir 0700, socket 0600. Startup prints `ABITO_DESKTOP_SOCKET=<endpoint>`
  (`main.rs:182`), byte-for-byte the legacy line.
- Override: `ABITO_SOCKET_DIR=<absolute, normalized dir>` for tests/probe.
  Relative or unnormalized paths fail closed; anything resolving into the
  installed Preview's reserved roots is refused (`resolve_runtime_from`,
  `src/transport.rs:199`). **A socket this process did not create is never
  removed**: cleanup verifies dir + socket dev/ino and `is_socket` first,
  and a non-empty directory aborts it (legacy `close()` semantics).
  Stale `p-XXXXXX` leftovers from earlier runs are never swept — exactly
  like the legacy receiver.
- Cleanup runs on: `quit` verb, window close, SIGINT, SIGTERM, and before
  the probe's hard exit.

### Notices are display text only (M2)

Transport callback → `notices.accept` → snapshot fields `notices`,
`connections`, `unavailable` (fed independently of `bridgeStatus`, which
stays M3's `disabled` — legacy keeps health-failure and Pi-connection state
separate too). The island renders them in the overview as Sileo-style text
(own code, total silence): generic title `Pi terminó su turno`, the generic
detail (never "the task went well", never "tests passed"), the count line,
and a `Descartar aviso` button wired to `dismiss`. **A notice never decides,
approves, focuses, expands or restores anything**; a snapshot never opens the
island by itself. Since M3, `allow`/`deny`/`choose` are wired through the
approval lane — a notice still never decides anything.

### Transport failures are notices too (#373, OD006/GD032)

The notice model carries an INTERNAL `severity` (`info` | `warning` |
`error`) and `kind` (`settled` | `transport`), single-sourced in Rust
(`protocol::Notice`); neither ever reaches the wire. A producer's `settled`
frame is byte-identical to before and still admits exactly one `info`
notice; `hello`/`heartbeat` and engine-facing types (`toast`, unknown) are
rejected at decode AND at `accept()` exactly as before. The page renders
only the kinds Rust admits and maps severity to a tone (error → red strip,
warning → sun, info stays neutral), announcing `Error:`/`Advertencia:` in
the pill's aria instead of relying on color alone.

A transport failure is a state-derived error notice led at the FRONT of the
queue: a connection drop (>0 → 0) shows `Conexión caída`, which clears
itself when a session reconnects, and a receiver that could not start
inserts `Avisos caídos` once (no retry exists — #373 keeps the
`unavailable` flag as the sole source of truth, so the notice persists).
Both go through the same `dismiss` verb, per failure event: a dismissed
event never resurfaces on its own, and the next DISTINCT drop shows a new
one. The failure notice never expires while the failure lasts (settled
notices keep their 60 s TTL) and survives a full queue — the oldest
settled notice is evicted instead. Detection lives in `NoticeStore`
(`connections_changed` / `transport_failed`), fed by exactly two `main.rs`
call sites (the connection-edge callback and the startup `unavailable`
path); `Snapshot`'s 13-key shape is unchanged.

### Unchanged Node producer against the Rust receiver (observed)

Integration test `unchanged_node_producer_connects_and_settles` spawns the
committed `adapter.cjs` + `core.cjs` + `transport.cjs` (read-only, plain
`node`, no npm install, no network, no writes) through
`test-node/producer-check.cjs` against a receiver bound in a private temp
dir: a real `hello → ready → settled` handshake, the adapter's `projectId`
sha256 equals the receiver's, the connection is counted, and the settlement
becomes exactly one notice. `pi-extension.ts` and `adapter.cjs` are
unmodified. (The adapter's own opt-in loader would only accept the legacy
`.runtime` or the Preview's root; the harness passes the runtime explicitly,
which is what a Pi session wiring would do through `ABITO_DESKTOP_SOCKET`.)

## What M3 proves (and what it does not)

The approval lane is a behaviour-equivalent port of the Electron host's HTTP
authority. Legacy values come from the committed read-only Electron source
(`worktrees/legacy-electron/apps/desktop`) and the read-only backend contract
(`src/sb_bridge/api.py`, `webapp.py`); Rust values from this crate. The pure
modules were written test-first (RED → GREEN) and the lane is
integration-tested against an **in-process fake backend** (`fakebridge.rs`,
`127.0.0.1:0`, std-only) — no real backend and no provider is ever contacted
by the tests or the probe.

### Parity table (M3)

| contract | legacy value (file:line) | Rust value (file) |
|---|---|---|
| bridge origin | `http://127.0.0.1:11003` — `security.cjs:13` | `requests.rs` `BRIDGE_ORIGIN` (env override below) |
| route allowlist (`GET /`, `/api/health`, `/api/proposals(?status=pending)`, `POST …/proposal_[0-9a-f]{32}/execute\|reject`) | `bridgeAllows` — `security.cjs:14-23` | `requests.rs bridge_allows` |
| credential file `<stateRoot>/bridge.json`, descriptor-safe (O_NOFOLLOW, our uid, not group/world-writable, 1..=2048 B, dev/ino/size/mode/mtime/ctime re-read) | `readBridgeLogin` — `main.cjs:87-108` | `approval.rs read_bridge_login` |
| login schema `{v:1, login}` + `^[a-z0-9][a-z0-9@._+\-]*$`, no whitespace/controls | `main.cjs:100-106` | `requests.rs validate_login_bytes` |
| auth modes `jar`/`explicit`/`none`, printed as the bare mode name | `mode()` — `main.cjs:110` | `retry.rs AuthLadder::set_mode` + the `log` hook |
| `bridgeStatus` transitions (`starting`/`healthy`/`unhealthy`/`stopped`/`disabled`) + `REASON` texts | `main.cjs:77-84,115` | `card.rs Reason`, `approval.rs set_status`/`stop_auth` |
| session cookie: value charset `\x21\x23-\x2b…` ≤4096, `Path=/`, domain `127.0.0.1`, expiry, **memory only** | `sessionCookie` — `main.cjs:125-136` | `approval.rs cookie_value_valid`/`parse_set_cookie` |
| one request: exact headers (`tailscale-user-login`, `X-SB-Request: 1` on POST, `Content-Type` only with a body, `Cookie` only as jar/explicit dictate), `redirect: manual`, 5 s absolute deadline covering the body, 401/3xx → stop auth, body discard, 1 MiB strict-UTF-8+strict-JSON cap | `request` — `main.cjs:138-192` | `approval.rs request` + `http.rs send` (`REQUEST_DEADLINE_MS=5000`, `MAX_BODY_BYTES=1 MiB`) |
| abort-on-quit of every active request | `activeRequests`/`quit` — `main.cjs:56,380` | `http.rs ActiveRequests::abort_all`, `approval.rs abort_lane` (wired into `quit_clean` + SIGINT/SIGTERM) |
| `mint`: ≤2 per process, `GET /`, jar must hold a valid cookie after, every failure stops auth | `mint` — `main.cjs:194-202` | `approval.rs mint` + `retry.rs try_mint` (`MAX_MINTS=2`) |
| the ladder: "only known rejected requests may be retried, never a network failure" — 403→explicit→remint→stop; a transport failure never touches the ladder | `authenticated` — `main.cjs:204-218` | `approval.rs authenticated` + `retry.rs classify`/`recovery_after_403` |
| proposals list: ≤100 entries, `pending` only, id `proposal_[a-f0-9]{32}`, hash 64 lowercase hex, operation ≤120 UTF-16 units/no controls, exact ISO-8601 expiry (leap-aware), duplicate ids fail closed, oldest-expiry sort with id tiebreak | `parseProposals`/`validExpiry` — `main.cjs:221-248` | `card.rs parse_proposals`/`valid_expiry` |
| pinned card semantics (open overlay pins, close/re-expand swaps, same-id refresh, changed hash → inert, expiry sticky on every projection, empty overlay never acquires) | `receiveCandidate` — `main.cjs:250-262` | `card.rs receive_candidate` |
| `cardReason` order: quitting → sticky → expiry → health → busy → compact → invisible | `main.cjs:265-274` | `card.rs card_reason` |
| card projection keys `{operation, expires_at, state, reason}`; `request` always the standing-request value (null today) | `projectedCard`/`snapshot` — `main.cjs:276-280,330` | `card.rs project_card`, `approval.rs snapshot_fields` |
| poll: health (`ok===true`) → proposals → receive; 10 s cadence; one in-flight; failure → unhealthy unless stopped | `poll`/`startBridge` — `main.cjs:282-303` | `approval.rs poll_once`/`run_bridge` (`POLL_MS=10000`) |
| `decide`: synchronous lock first, gate re-validated before EVERY send, `/execute` body exactly `{"payload_hash":…}`, `/reject` bodyless, 2xx→`Decisión enviada.` else `No se pudo confirmar la decisión.`, quit → nothing is claimed | `decide` — `main.cjs:305-328` | `approval.rs decide` |
| overlay epoch bumps on every phase transition; expand promotes the pinned queue | `main.cjs:375,466-467` | `approval.rs bump_epoch`/`promote_selection`, called from `main.rs` `restore`/`dispatch_verb` |
| `choose`: read-and-consume in ONE synchronous step; no request stands → `Denied` | `main.cjs:444-449`, `core.cjs:89` | `approval.rs choose` + `card.rs choose_request` |
| the three verbs run behind the same validation+rate gate | `main.cjs:452-456` | `main.rs desktop_action` (async since M3; allow/deny run on the blocking pool) |

### What the approval evidence shows (probe, `approval_evidence` line)

- The lane starts against the **in-process fake backend** through the
  `ABITO_BRIDGE_BASE` override (set before the lane is built): the probe
  never talks to a real backend, and when `ABITO_BRIDGE_BASE` was set from
  OUTSIDE, the probe reads snapshots but refuses to decide.
- `posts_before_choice: 0` — nothing (notice, snapshot, poll) ever writes;
  only the explicit `allow` dispatch reaches `/execute`, and then
  `execute_payload_hash_matches_card: true` with `session_cookie: true` and
  `x_sb_request: true` on the POST. `bridge_status_before/after` and
  `card_before/after` are read through the REAL snapshot path
  (`pending` + `healthy` → `inert` + `Decisión enviada.`).
- `facade_evidence.choose_wired_denied: true` — through the real webview
  IPC, `choose(0)` answers the typed `denied`, not `not-yet-wired`.

### Secrets and storage contract

- The session cookie exists **only in the Rust process memory** of the lane
  (`Approval.cookie`): never localStorage, never any value the WebView can
  read, never written to a file, never logged — the only auth diagnostic is
  the bare mode name (`jar`/`explicit`/`none`), exactly like legacy.
- The credential is the `bridge.json` **login** (a Tailscale identity), read
  from the state root with the legacy descriptor discipline. It is never
  printed and never committed (`.runtime*/` is gitignored).

## What U1 proves — chat inside the island, answered by the LOCAL model

**One table of logical sizes per view (#337 F009).** Every native window size the
island ever takes — compact dot (#302), overview (#309 contract), chat column
(#309), Ajustes column (#408) — is one entry of `geometry::view_sizes(View, area_w,
area_h, scale)`, the single routing point for sizes; `core.rs` plans every toggle,
view switch and Settings grow through it. The arms delegate to the per-view
functions, so the frozen contracts keep owning their numbers; no view size is
decided anywhere else.

**Placement per screen (#337 F010).** The work area honours the monitor the island
is on. `workarea::monitor_work_area(monitor, insets)` is the pure, injected-monitor
decision: the monitor bounds minus the decorative frame the platform reports (menu
bar / notch at the top, dock at a side or the bottom), refused when nothing usable
remains. Win32's `rcWork` is exactly that subtraction (pinned by test); on unix no
notch/menu-bar inset source exists today — GNOME publishes the panel-subtracted
`_NET_WORKAREA`, which `pick_work_area` intersects with the monitor the island is
on, so placement there is the usable work area unchanged. Single-monitor behavior
is untouched.

**Chosen monitor (#389 GD012).** Ajustes → Panel may pin the island to ONE monitor:
`prefs.json` v1 gains the optional `monitor` key — the platform's stable monitor name
(the X11 output name such as `eDP-1` / `HDMI-A-1`, the Windows device name such as
`\\.\DISPLAY1`), bounded, trimmed, no control characters, never a prototype key. The
key is built from nothing but the monitor names the island itself enumerated; no
inference, no user typing. Absent (and never written by an untouched file) = today's
behaviour, provably: `workarea::chosen_area(None, current, …)` returns exactly the
`workarea::current()` value. Placement (first pin, restore), edge snapping and the
work-area watcher resolve their area through `workarea::chosen_area` — exact key match
with valid geometry wins; an unknown key, a disconnected monitor, nothing enumerable
or a degenerate geometry falls back to the island's CURRENT monitor. A stored key the
island cannot see right now is NOT dropped on load: the fallback happens at placement,
so a redocked laptop restores the choice. The chosen monitor's bounds are its work area
(`monitor_work_area(rect, None)`); per-monitor decorative insets remain observable only
for the monitor the window lives on. IPC: `set_monitor` (exactly action + monitor) and
`clear_monitor` (exactly action) behind the same closed schema, rate limit, gate and
atomic writer as every preference; a refused shape leaves state and bytes identical.
Projection: `prefs_action` and `prefs:state` carry `monitor` (string or null); the
Settings UI itself is a later card.

**Same island, a vertical column (#309).** A short click on the compact island still
opens the approved **640×160 overview** (M1 contract, untouched). Its most
prominent control, **Conversar** (≥44 px, also `Enter` in the overview),
switches the SAME window to the **chat column: visible 400 wide, native 432
wide, r22**, gentle-shell style (history, composer, a strip for the agent
state). Its height follows the work area: `geometry::chat_visible` gives
**640 when the screen allows it, otherwise work-area height − 40 px of air,
never below 240**; native adds the overview's 32×16 margins (432×656 on a
1048 px work area). Rust owns every number and pushes the visible size to the
page (`__islandSetView`); the frontend never decides the height. The column is
centred under the overview it replaces and keeps the docked edge (grows
upward from the bottom). Overview (672×176) and column move in opposite
directions per axis, so the window first becomes a **stage** that holds both
(`geometry::stage_size`, per-axis maximum, 672×656), the page animates inside
it with the R6 contract, and the window settles on the final rectangle
afterwards (700 ms opening, 400 ms closing, generation-guarded like every
deferred resize). `Volver` returns to the
overview (the draft stays in page memory, never on disk); `Escape` leaves
the composer, a second `Escape` collapses the island; a collapse always
forgets the chat view so the next click opens the overview again.

**Local model only — never a silent fallback.** The chat lane
(`chatlane.rs`) talks to the selected local target, today
`http://127.0.0.1:11002` alias `Abito-gpt`, through `localmodel.rs`:

- `LocalEndpoint` accepts only literal loopback (`127.0.0.1` / `[::1]`), plain
  HTTP, origin only — `localhost`, LAN, tailnet, TLS and cloud hosts are
  refused by construction (no DNS lookup can redirect the request),
- per turn: a metadata preflight (`/health`, `/props`, `/slots`,
  `/v1/models` — no inference), then **exactly one** streamed
  `POST /v1/chat/completions` naming only the alias; no tools, no key, no
  retry, redirects never followed,
- router down → `local_model_unavailable`: *“El modelo local no responde: el
  chat no está disponible. No se usó ningún otro modelo.”* Opening the chat
  runs the same metadata check, so the chat says it before anyone types and
  `Enviar` stays disabled,
- model asleep (`/props is_sleeping`) → `resource_authorization_required`:
  sending would make the router load ~18 GB, so nothing is sent and nothing is
  loaded; another alias loaded → unavailable, never substituted; slot busy →
  visible “espera en su cola”, one request,
- history trimmed against the model's REAL context (`/slots n_ctx`) and shown
  (“se dejaron afuera N mensajes”), never a bigger context; the 32,000-scalar
  response cap ends with an explicit limit note; cancel is terminal and
  shuts the socket down.

**Contract (`chat.rs`, pure, RED → GREEN):** the `abito.chat.v1` subset a
local model can honestly produce — native ids, duplicate client id → same
turn, one running turn (`queue_full`), monotonic `seq` (gap/regression/
after-terminal rejected), states `queued|thinking|streaming|waiting_approval|
completed|cancelled|error`, safe typed errors, draft ≤8,000 scalars, active
context cache ≤100 turns / 256 KiB. Persisted presentation pages (#341) are
separate and never enlarge that context budget. `waiting_approval` exists in the machine but nothing
can enter it: **there is no Pi chat producer on the desktop yet**; the view
says so (`producer.pi: "not_connected"`). That adapter is a marked future
dependency, not simulated.

**IPC:** one new command, `chat_action`, behind the same sender gate as
`desktop_action`, its own 30/s rate budget, a 33 KiB payload cap and the
closed set `view|open|back|check|submit|cancel|new|list|restore|history`
with exact keys — a page
cannot name an endpoint, model, key or approval (the probe proves a
smuggled `model` field is rejected). Events: `chat:state`. The
`desktop:state` 13-key snapshot is unchanged; no new capability or CSP
origin was added (the WebView never talks HTTP; Rust does). #343 adds
two more gated commands to the closed set: `chat_attach` (a dropped path;
Rust reads ≤10 MiB, validates against a content-based MIME allowlist and
copies the file into the island workspace's `uploads/` directory) and
`chat_attach_data` (a picked file as raw bytes: one-line JSON name header,
LF, file bytes). Both return `{id, name, mime, size}` or a safe Spanish
error; rejected files are validated BEFORE the first write, so a refusal
stores nothing. The page references attachments by id only; submit
carries the ids, prompt building inlines text files and sends images as
`image_url` parts gated on the router's `/modalities/vision` (a
vision-less model gets a safe error turn, never a silent drop).
**Dropped-path hardening (R3 review finding):** `chat_attach` accepts ONLY
a path the OS reported through the main window's native `DragDrop(Drop)`
event (`main.rs` records it into a one-shot `uploads::DropSet`: bounded to
16 entries, 60 s TTL, consumed on use). A path the page names that was
never dropped — or dropped longer than 60 s ago, or already attached — is
refused before anything is read. `read_dropped` stats with
`symlink_metadata`, so symlinks (and any non-regular file) are refused
instead of followed: a dropped symlink to a readable file stores nothing.

**Accessibility/motion/silence:** named controls ≥44 px (probe-measured),
text status independent of R6, polite live region once per state change or
finished answer (never per token), plain text via `textContent`, the
composer's Enter guard consumes only the identity signals an IME exposes
(`isComposing` and the legacy 229 sentinel) and its known gap is written out
in «Verifying U1» below, focus moves to the composer only on a deliberate
keyboard open or a click; overview↔chat uses the contract spring/340 ms curve and snaps under
`prefers-reduced-motion`; no audio elements, no sound. The island's own window drag never
attaches to the transcript or composer; the ONLY drag the chat listens for is #343's file
drop (`tauri://drag-drop`, chat view only, paths forwarded to `chat_attach` — malformed
payloads are ignored, only paths the OS dropped natively are accepted (see
the hardening note above) and rejected files leave nothing behind). R6 is only scaled/positioned
(sha256 unchanged).

**Local conversations (#341 / F026, OD003, OD004, GD022, GD037).** The
new-chat button or **Ctrl+N** clears the current context and draft without
deleting saved history. The clock button lists conversations newest first,
with the first-message title (80 Unicode scalars plus ellipsis), creation-time
specialist and last activity. Opening restores the newest 25 turns; scrolling
up loads older pages while preserving the reader's position. Finish or cancel
a running reply before switching. A deleted specialist falls back to Abito
principal with a visible notice; no alternative model is silently selected.

History uses append-only JSONL in `app_data_dir/conversations/` (Unix directory
0700, files 0600) plus an atomic index. Malformed records are skipped and
reported, and interrupted turns restore as cancelled without resuming inference.
Accepted message text is persisted as written; app credentials, headers, account
state and system/specialist instructions are not copied. Files are not encrypted.
Probe mode is memory-only unless `ABITO_CONVERSATIONS_DATA_DIR` names an absolute
isolated test directory. Deletion, retention limits, cloud sync and import are
out of scope. See [Local conversations](../../docs/conversations.md) for IPC,
paging, privacy and the **partial final verification evidence**. No live app
verification was performed in this workstream; parent verification remains open.

**The empty-chat greeting (F027 / TaskView342).** With no message yet the column shows
what §2.3 shipped: the lock `local` + eye-off pair, centred, and the whole sentence in
`aria` (*«Escribile a Abito. Responde el modelo local de esta máquina; no ve tu pantalla
ni ejecuta nada.»*). An **explicit** display name in the `chat:state` payload
(`display_name`, a string) adds one visible line under the pair — **«Hola, <nombre>.»** —
and prefixes the same sentence in `aria`. The name is never guessed: no OS user, no
account, no provider, no branding, no profile lookup. It is text the person typed, so it
is cleaned and bounded in `chat-view.js` (`emptyGreeting` / `cleanDisplayName`): a
non-string or a blank/control-characters-only value reads as **no name**, control
characters become spaces, and the value is cut to **80 Unicode scalars** (never splitting
a surrogate pair) — the same bound as the local preference validator. Absent or blank keeps
the shipped state **byte for byte** (icons only, sentence in `aria`), and the row is
redrawn when a name arrives on a later push instead of staying stale. The greeting is
written with `textContent`; the greeting renderer has no HTML write. Existing
closed-registry icon writes elsewhere are unchanged.

**Explicit local preference (v1, no onboarding/profile inference).** `prefs_action`
accepts exactly `{"action":"set_display_name","display_name":"Ana"}`. The string must
contain at most 80 Unicode scalars and no control characters; leading/trailing
whitespace is trimmed, and an empty/whitespace-only string clears it. Extra keys,
non-strings, controls and overlength values return `invalid_schema`. The persisted
`prefs.json` stays **v1** with optional `display_name`, omitted when anonymous.
Missing/invalid name on load defaults to anonymous without losing `sound`.
Sound toggles clone current preferences and change only sound; setting/clearing the
name changes only the name. No-op/view commands do not write. A failed save returns
`save_failed` without installing or publishing the requested value. Settings responses
and `prefs:state` carry `displayName` (string or null); `chathost.rs::chat_view` supplies
`display_name` to chat, including startup reads and pushes after successful changes.
`prefs::transact` holds a shared command gate through persistence, installation and
publication: the next preference command cannot overtake the current event. The
state mutex is released before publication, so chat can re-read the committed name.
Publish callbacks must not recursively call `transact`. The response/event uses the
committed snapshot rather than an unlocked later read. This orders preference-command
publications, not every unrelated chat producer in the application.

Reproduce concurrent **real fields** (`sound` and `display_name`) and failed-save
checks without a display or provider call:

```sh
CARGO_TARGET_DIR="$PWD/evidence/integration-327-342-384/cargo-target" \
  cargo test --offline --locked --manifest-path apps/desktop-tauri/Cargo.toml \
  --lib prefs::tests::concurrent
```

These tests use the public transaction seam used by `settingshost`, concurrent
threads released by a barrier, serialized JSON readback and publication callbacks.
They assert the gate remains held until publication, the state mutex is released,
event order equals commit order, both fields survive, and failed persistence neither
replaces the prior name nor emits an event. Persistence failure is injected at the
callback boundary; this is not an OS write-failure or live Tauri event-delivery test.

**Optional name in Ajustes:** under Saludo, **Tu nombre (opcional)** explains the
80-character limit and anonymous fallback. **Guardar nombre** (or Enter) sends the
explicit preference command. Clear the input and save to return to anonymous. The
form validates scalar count and controls, preserves drafts across preference pushes,
and retains the text, focus and an actionable error after a failed save. It announces
success only after IPC resolves; the backend remains validation authority.

### Verifying U1

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
#   lib 147 (+chat 30, localmodel 13, chatlane 9, geometry 3, core 4)
#   chat_local_model 14 (in-process fake router; 1 opt-in real smoke)
#   frontend_chat_view 1 (runs test-node/chat-view-check.cjs, 8 checks)
#   frontend_chat_composer 1 (runs tests/composer-ime-check.cjs, 10 checks + limits probe)
node apps/desktop-tauri/test-node/chat-view-check.cjs

# composer keyboard contract (#372): drives the REAL frontend/chat.js over a fake DOM
# with plain node (no browser, no npm, no network). Proves Enter sends (one submit with
# the draft, cleared), Shift+Enter keeps the textarea's own newline and sends nothing,
# `isComposing` sends nothing, the legacy 229 sentinel sends nothing, and an intentional
# Enter shortly after a composition still sends. It then PRINTS a limits probe: where the
# engine delivers the candidate-confirming keydown AFTER `compositionend` with a plain
# `keyCode` 13 (WebKit bug 165004, older reports), that keydown carries no signal that
# tells it apart from an intentional Enter, so it sends — this is a known gap, not an
# IME-safety guarantee. A time window is deliberately NOT used for it: it swallows real
# Enters (TaskView #372, parent decision 2026-10-13). Real WebKitGTK/IME ordering is NOT
# exercised here: no IME, no engine drive, no browser.
node apps/desktop-tauri/tests/composer-ime-check.cjs

# opt-in: one short real turn against 127.0.0.1:11002 (local, free)
ABITO_REAL_LOCAL_MODEL=1 cargo test --manifest-path apps/desktop-tauri/Cargo.toml \
  --test chat_local_model real_local -- --nocapture

# probe: adds chat_open (672x256 from the X server), chat_evidence (one turn
# via the REAL chat_action IPC against an in-process FAKE router, then an
# unreachable target), chat_back_to_overview (672x176), chat_collapse
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 200 cargo run
```

## What U2 proves — choosing a self-hosted model (local only, no keys)

The chat header's **Modelo** button opens an internal panel of the SAME chat
view (the transcript is replaced while it is open). It lists the verified
local inventory (`models::REGISTRY`, a reviewed code constant):

| entry | state | selectable |
|---|---|---|
| `http://127.0.0.1:11002` · `Abito-gpt` | live metadata + gate | yes (the only one) |
| `127.0.0.1:11014` | `unknown` — 404 at root, identity unverified (inventory 2026-10-08) | no, never contacted |
| `127.0.0.1:11017` | `unavailable` — did not answer (inventory) | no, never contacted |
| any other alias the router lists | shown “no verificado” | no |

Visible metadata per row: endpoint, alias, context (`/slots n_ctx`), output
cap (1,024), size in memory, parameters, quantization, vision yes/no — read
by four bounded GETs (`/health`, `/v1/models`, `/props`, `/slots`) on
**Actualizar** or on opening the panel; never an inference to fill a picker.
The UI says plainly: *“Hoy hay un solo modelo local verificado: una sola
opción no es una elección.”* and *“Sin nube y sin claves.”*

**Resource gate, not cost:** `models::gate` separates `ready` (loaded,
awake, idle), `queue` (slot busy — a send waits, shown), `needs_load`
(asleep, or listed but not the loaded alias — shows the size to load and the
available RAM; **Abito never loads, downloads or evicts**), `unknown`
(state unreadable — nothing is sent) and `unavailable` (router down / alias
gone — never substituted). The resource line shows RAM
(`/proc/meminfo`) and GPU VRAM/GTT (amdgpu sysfs counters), read-only, no
privileges. Before every dispatch `main.rs model_gate` requires the frozen
target to still be a registered selectable profile at the same revision,
origin and alias; the per-turn preflight then applies the resource half.

**Selection:** IPC `models_action` with the closed set
`list|refresh|select{profile_id}` (same sender gate + rate limit). There is
no add-endpoint, no key entry and no origin field (the probe proves
`set_key`/smuggled `origin` → `invalid_input`, a diagnostic or unknown id →
`profile_missing`). A selection applies from the next message; a running
turn keeps its frozen target. It is persisted as
`<app config dir>/models-selection.json` = `{"v":1,"selected":"…"}` (dir
0700, file 0600, atomic temp+rename, read with `O_NOFOLLOW` + owner/mode
checks). Absent → the approved initial `local-abito-gpt`; corrupt, foreign
or unknown → **no model selected** (the chat says so, nothing substituted).
The probe never writes it (`persisted_config_dir: null`); tests use a temp
dir; `ABITO_MODELS_CONFIG_DIR=<abs dir>` overrides.

### Verifying U2

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
#   lib models 19 (registry, parsing, gate, listing, IPC, saved file)
#   models_selection 5 (fake routers: metadata only, diagnostics never
#   contacted, sleeping = needs_load with 0 completions, 0600/0700, symlink
#   and world-writable dir refused)
# probe: models_evidence — rows rendered with 44 px buttons, gates
#   ready/unknown/unavailable, select diag/unknown refused, set_key and
#   smuggled origin refused, selection effective, fake router saw only GETs
```

## #339 / F024 — the model row above the composer

The chat column carries one row between «Respuesta nueva» and the composer: a
button with the availability dot, the effective local model's name and a
caret, plus an inline picker above it. Upstream Coucou's “Click model name
above composer” (`windows/src/views/chat.ts:216-254`); the macOS popover
itself (`IslandViewContent.swift:1345-1375`) is not ported, per the 0.2 scope
rule.

**What it shows (R1/R4):** the EFFECTIVE target of the next turn — Rust has
already resolved the active specialist into `chat:state.target`
(`chathost::current_target` → `specialistshost::turn_snapshot`), so the row
names exactly the model that will answer. The alias, or the profile id when it
has none; «Sin modelo local elegido» when there is no target; and the role's
name appended («Abito-gpt · Investigación») only when that role is what
supplies this exact model, with a one-line note inside the picker. Plain text
only (`textContent`), the origin rides in the accessible name without its
scheme, and never an endpoint, key, account or provider (S5).

**What a click does (R2/R3):** toggles the picker over the SAME closed
`models_action` set Ajustes → Modelos uses — `list` on open,
`select{profile_id}` on a row — so a selection applies from the NEXT message
(a running turn keeps its frozen target) and nothing new reached the wire: no
new verb, no new preference, no Rust change, and `chat_action`'s closed set is
untouched. Escape closes the picker first; a running turn freezes the row; a
CHOSEN target that is down or blocked disables it, while no target chosen (or
no preflight verdict yet) keeps it enabled — otherwise the picker would be a
dead end exactly when the human needs it.

**What it is not:** not a per-turn override; not a provider picker (the chat
lane is local-only, `src/chatlane.rs`; cloud chips would need a new wire verb
plus a daemon round trip and engine restart, out of 0.2); and it never writes
a role. `chat.js` may invoke exactly `chat_action`, `open_chat_url`,
`models_action {list,select}` and `specialists_action {view}` — a check pins
that set so a later edit cannot grow it silently.

### Verifying #339

```sh
node apps/desktop-tauri/test-node/chat-view-check.cjs         # 52 checks (5 pure F024: label/aria/note/enabled/markup)
node apps/desktop-tauri/test-node/chat-model-picker-check.cjs # 10 checks, fake DOM driving the REAL chat.js
node apps/desktop-tauri/tests/composer-ime-check.cjs          # 10 checks: the keyboard contract still holds
# cargo test runs both harnesses through tests/frontend_chat_view.rs
```

## #327 — manual specialists (roles the human creates and chooses)

A specialist is a role the human creates by hand and picks explicitly: a
display name, the instructions that specialise it and, optionally, one of the
verified LOCAL models. It never delegates, spawns, schedules, widens a
permission or reaches another backend: choosing a role only changes what the
NEXT turn asks for and which local model answers it.

**Store:** `<app config dir>/specialists.json` = `
{"v":1,"active":<id|null>,"specialists":[{"id","name","instructions","model","space","permissions"}]}`
(`space` and `permissions` are the #375 additions; see the section below)
(dir 0700, file 0600, atomic temp+rename, read with `O_NOFOLLOW` + owner/mode
tests). Only a genuinely absent file loads as a healthy empty store. Existing
corrupt, unreadable, wrongly versioned, oversized or invalid-record data returns
an explicit load failure. No partial list is advertised as successfully loaded.
The host latches `load_error: true`, sets `persisted: false` and rejects **all**
mutations with code `load_error` and message
`No se pudieron cargar los especialistas; no se cambió nada.`
`view` still returns state with that flag, without paths or stored content.
No success event, auto-reset, repair, quarantine or overwrite occurs; recovery
is outside this feature and requires an explicit decision. Moving a bad file
after startup does not clear the latch. `active: null` IS the principal (Abito).
`ABITO_SPECIALISTS_CONFIG_DIR=<abs dir>` overrides; without that override,
the probe keeps it in memory only. Unix permissions/owner checks are not a
verified Windows security guarantee.

**Identity:** the id is opaque, lowercase ASCII,
`^[a-z0-9][a-z0-9._-]{0,31}$`, generated ONCE at creation and stable across
renames — never derived from the name, the provider or a CLI id. The reserved
identities (`abito` the principal, `pi`/`claude-code`/`codex`/`opencode`, the
prototype keys) are refused, so a specialist can never impersonate the
principal. **No colour lives here:** the avatar panel resolves it for the SAME
id (`avatar_colors` owns assignment and overrides).

**Bounds:** name 1..40 and instructions 1..2000 characters. Instructions keep
normal line breaks and tabs (a prompt section is genuinely multiline); other
C0/C1 controls and DEL are refused, in the raw text, before trimming.
Capacity remains **24 roles**. The persisted byte bound is derived from the
maximum compact v1 JSON: outer syntax + active ID (32 ASCII bytes), 24 records
(each including syntax, ID32, model64, name40×4 and instructions2000×4 bytes),
and 23 separating commas. UTF-8 uses at most4 bytes per scalar; the permitted
JSON escapes use at most2. Reads check both metadata and the final bounded
buffer; writes reject oversized or non-round-trippable candidates before any
filesystem mutation and refuse to replace an unreadable existing store.

**IPC:** `specialists_action` with the closed set
`view | create{id,name,instructions,model} | update{…} | delete{id} | select{id|null}`
(same sender gate + rate limit as the rest of the island). A named model must
be a SELECTABLE entry of the verified local registry — today exactly one
(`local-abito-gpt`), which the section says out loud instead of pretending to
choose. Creating is not choosing: a new role does not become the active one.

**Coherence:** one transaction lock serializes read/validate/write/commit/event
publication. The file is written FIRST and memory is committed only when the
write succeeded; a failed save leaves the previous roles (and the role in use)
exactly as they were and reports it, so the panel can never announce a role
that was not saved. Nowhere to persist (probe) is a memory-only change that
says so.

**One turn:** the effective system message is the base `chatlane::SYSTEM_PROMPT`
plus the role (base policy first, guard rails restated, no capability gained);
the effective target is the role's model when it names one, else the model
picker's selection — and a role whose model is no longer selectable REFUSES the
send instead of substituting another model. Both are frozen at submit, so
choosing another specialist while a turn runs changes the next turn, never the
one in flight. With `active: null` the system message is byte for byte the base
one.

**UI:** a section inside Ajustes (no new screen, no new icon) where the human
creates, edits, chooses and goes back to the principal, plus a display-only
role chip in the chat header. Plain text only; only trusted gestures change
anything. Arrow keys (wrapping), Home and End choose through the same selection
path after a trusted keydown, never a synthetic click; focus returns after the
IPC result. Save failures retain the draft/error until successful retry.
`load_error` shows a persistent unavailability notice, hides healthy role choices
and disables mutations; no reset is offered. A draft already open is retained.
Isolated Chromium/CDP with explicit mock IPC checks these paths; it is not native
Tauri proof. UI/native acceptance remains with the parent. Scripted `dispatchEvent`
cannot replace trusted input. Do not bypass the gesture guard.

### #375 — declarative Space name and permissions per specialist

Each specialist carries two OPTIONAL fields. **Both are declarative only:**
nothing resolves, injects into the prompt, grants, enforces or executes them,
and no capability widens. The UI says so («Declarativo: todavía no se aplica»).

- `space`: a free-text Space NAME (no registry exists), trimmed, 1..80
  characters, every control refused. `null`/absent = none; `""` clears it.
- `permissions`: a subset of the closed vocabulary
  `read | write | network | execute`, stored in that canonical order, never
  empty. Read-only (`["read"]`) is the default and the floor.
- Absent fields behave as before. A hostile STORED value is dropped, not
  executed: the record still loads, `space` becomes absent and any unknown,
  non-string, non-array or empty permission set degrades to `["read"]`
  (stored duplicates collapse).
- IPC: `create`/`update` still accept today's exact five-key shape; `space`
  and/or `permissions` may be added. Unknown keys, unknown or duplicate
  permissions and hostile Space names are refused and change nothing.
- The persisted byte bound includes the widest Space name (80×4 bytes) and the
  widest permission array.

### Verifying #327

```sh
cargo test --manifest-path apps/desktop-tauri/Cargo.toml --bin abito-island specialists
#   Store/host contracts: opaque/reserved ids, bounds and controls, fail-closed
#   store, closed command set, invalid input never mutates, principal prompt
#   unchanged, 0600/O_NOFOLLOW/atomic file, failed write keeps the store,
#   concurrent update/event ordering, stale model rejection, coherent frozen role,
#   maximum Unicode+IDs+models roundtrip, escaped JSON and exact/over-limit bytes,
#   corrupt/oversized startup mutation block, original bytes preserved, absence
cargo test --manifest-path apps/desktop-tauri/Cargo.toml --test frontend_specialists
node apps/desktop-tauri/test-node/specialists-view-check.cjs   # 21 checks
# Previous visual probe produced neither settings_section evidence nor PNGs.
# It was stopped; visual acceptance belongs to the frontend review.
```

## Q1 — island accessibility (observed)

- **No focus stealing:** `tauri.conf.json` window `focus: false`; `restore()`
  (second launch) shows the island without `set_focus`. Probe
  `a11y_evidence`: `window_focused_at_start/after_restore/after_expand:
  false`, `document_has_focus: false`. The ONLY focusing path is the
  deliberate second launch `abito-island --chat` (exact argv, pure
  `desktop::launch_intent`, tested): opens the chat and puts the caret in the
  composer — bind it to a GNOME shortcut yourself; Abito installs no global
  hook.
- **Keyboard:** once the human focuses the island, Tab reaches
  `#island-toggle` (“Abrir/Cerrar Abito”, `aria-expanded`, focus ring drawn
  on the island); Enter/Space opens the overview and focus moves to
  **Conversar**; Escape steps out of the composer, then collapses and
  returns focus to the island control.
- **44 px:** every visible control measured in the probe ≥44×44
  (`all_visible_at_least_44: true`: Conversar 132×44, Permitir 82×44,
  Denegar 83×44; Descartar aviso, chat and model controls likewise). The
  overview columns were narrowed (notices 236 px, card 228 px, both
  scrollable) so nothing overlaps the bottom-centre Conversar slot.
- **Screen readers:** notices are announced once per NEW notice in a polite
  `role=status` region (`Aviso: <title>. <detail>`), never on dismissal;
  the chat has its own polite region (per state change, not per token).

## Configuration: pointing at the real backend later

Nothing to do for the shipped default: the lane targets
`http://127.0.0.1:11003` (`security.cjs BRIDGE_ORIGIN`) and reads
`<stateRoot>/bridge.json` — the dev state root is `apps/desktop-tauri/.runtime`
(`ABITO_SOCKET_DIR` overrides the whole state root, as for M2). To enable the
real lane:

1. Create `.runtime/bridge.json` (mode **0600** — the descriptor gate
   refuses group/world-writable files, exactly like legacy) containing
   `{"v":1,"login":"your-login@tailnet.ts.net"}` — the same tailnet login
   the backend allows.
2. Start the Second Brain bridge on `127.0.0.1:11003`. If it lives
   elsewhere, set `ABITO_BRIDGE_BASE=http://127.0.0.1:<port>` (origin shape
   only: `http://host:port`, no path/query/fragment). **Only point this at a
   backend you intend the app to drive** — it is the approval authority.
3. Without `bridge.json` the lane reports `bridgeStatus: disabled` and makes
   zero requests (fail closed), which is also what the tests and the probe
   rely on.

## Verifying M3

```sh
# all tests: 88 unit (50 pre-M3 unchanged + 34 M3 pure RED→GREEN + 4 M3
# unit) + 17 approval integration (in-process fake backend) + 8 M2 = 113
cargo test --manifest-path apps/desktop-tauri/Cargo.toml
cargo build --manifest-path apps/desktop-tauri/Cargo.toml
sha256sum apps/desktop-tauri/frontend/clay-engine.js   # R6 frozen, unchanged

# probe WITH the socket override; the approval step spawns its own fake
# backend and sets ABITO_BRIDGE_BASE itself (in-process, loopback only):
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 150 cargo run
# → approval_evidence line:
#     base_origin_env "http://127.0.0.1:<fake>", fake_backend_spawned true,
#     posts_before_choice 0, card_before.state "pending" →
#     card_after.reason "Decisión enviada.",
#     execute_payload_hash_matches_card true,
#     bridge_status_before/after "healthy"
# → facade_evidence: choose_wired_denied true
# → stdout also prints the bare auth mode line `jar` (legacy parity)
```

## What M1a proves (and what it does not)

Proven by the probe's read-back, not by intention:

- native geometry per state: compact **304x44**, overview **672x176**
  (visible island 288x32 r14 / 640x160 r22 inside those windows),
- origin at the **top-centre of the work area**, clamp to the work area
  (X11 `_NET_WORKAREA` intersected with the monitor, scale-aware), X kept on
  snap (clamped only),
- **grow direction**: expanding while docked at the bottom keeps the bottom
  edge anchored (grows upward); at the top it grows downward; X centre anchored,
- window attributes: transparent, undecorated, always-on-top, skip-taskbar, no
  shadow, not resizable (the probe prints `is_always_on_top` / `is_decorated`),
- drag release never toggles; a short click (< 6 physical px movement) toggles
  compact↔overview — threshold and snapping live in the pure `geometry` module
  with unit tests (`cargo test`, test-first: RED → GREEN),
- original M1a R6 rendered as SVG-DOM in WebKitGTK (historical evidence).
  #347 now pins its own R7 engine at SHA-256
  `b699ebbc9e4d92b7a0ffbb213af32c58e0b164715f20dde25709ee14a9ccf76e`;
  that source update is not a claim of new native acceptance.

Not in this unit (later sessions): `window.desktop.*` bridge (M1b),
capabilities/CSP hardening (M1b), UDS transport (M2), approval HTTP (M3),
packaging/replacement of the installed Preview (M4, needs separate human
authorisation).

## Verifying M1b

```sh
# unit tests (bridge validation, snapshot/transition, geometry, core)
cargo test --manifest-path apps/desktop-tauri/Cargo.toml

# read-back probe: geometry + facade verbs + typed rejections + rate limit
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 timeout 120 cargo run
# → check the `facade_evidence` line: verbs_match_preload true,
#   invalid_call.rejected true with code "denied",
#   rate.rejections == 10 of 40 with code "rate-exceeded"

# single instance
DISPLAY=:0 XAUTHORITY=… GDK_BACKEND=x11 nohup ./target/debug/abito-island &
DISPLAY=:0 XAUTHORITY=… GDK_BACKEND=x11 ./target/debug/abito-island  # exits 0 at once
pgrep -c -x abito-island   # → 1
```

## Verifying M2

```sh
# all tests: 9 protocol unit (RED→GREEN) + 3 transport policy unit +
# 37 M1b tests (unchanged) + 8 receiver integration tests over real sockets
cargo test --manifest-path apps/desktop-tauri/Cargo.toml

cargo build --manifest-path apps/desktop-tauri/Cargo.toml
sha256sum apps/desktop-tauri/frontend/clay-engine.js   # R6 frozen, unchanged

# probe WITH the socket override (its own dir — never the Preview's root):
cd apps/desktop-tauri
DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.UV9RW3 \
  GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_SOCKET_DIR="$PWD/.runtime-probe" \
  timeout 120 cargo run
# → transport_evidence line:
#     ready_ok true, frames_sent 2, notice_count 1,
#     connections_while_connected 1 → connections_after_disconnect 0,
#     preview_roots_detected_only[].connected_or_removed false
# → stdout also prints ABITO_DESKTOP_SOCKET=<endpoint> (legacy line)
```

## Behaviour notes

- **Drag**: pointer tracked inside the webview; `drag_press/drag_move/
  drag_release` commands call the Rust core handlers. No global input hooks.
- **Motion**: grow = spring response 0.5 s, damping 0.72; shrink = 340 ms
  `cubic-bezier(.45,0,.2,1)` (the native window resize waits ~400 ms for it);
  `prefers-reduced-motion` snaps both directions. **Silence: no sounds at all.**
- **Click vs drag**: movement `< 6` physical px on release = click (toggle);
  otherwise a drag (snap to the nearest vertical edge, no toggle).

## Wayland limitations (why X11 is forced)

Under Wayland, per official Tao documentation:

- `set_outer_position` / absolute positioning: **not supported**,
- `set_always_on_top`: **not supported**,
- `cursor_position`: returns `0,0`,
- `_NET_WORKAREA` does not exist (no EWMH), so panel-aware clamping is
  impossible — only full monitor geometry would be available.

Without X11/XWayland the island cannot dock to a chosen edge, cannot be kept
above other windows, and cannot be clamped to the usable work area. The
`GDK_BACKEND=x11` launcher and the in-`main()` fallback are therefore load
bearing, not cosmetic.

## #384 — the Dot's avatar colours (frontend candidate)

`frontend/avatar-colors.js` is the pure contract for the Dot's colour, from the human

> «colores en ajustes por si alguien lo quiere cambiar, pero fijo el verde y los sub abitos especializados de difrentes colores»

- **The principal Abito is green by default.** No pose, activity, host condition, connected agent,
  notice or card is an input: `resolveColor(identity, overrides)` takes exactly those two arguments and
  ignores anything else a caller passes. An explicit human choice in Ajustes is the only thing that
  changes it — an explicit preference is not an identity and not an active agent, so refusing it would
  be inventing a prohibition nobody asked for. The default green is the frozen R6 engine's own skin
  gradient; the module never touches the engine, the island markup, CSS geometry or transparency.
- **A specialised sub-Abito has a stable identity color** over blue/mint/orange/purple:
  `defaultColor(identity)` uses FNV-1a/32 over the canonical id, independent of set membership.
  Adding or removing another specialist never repaints it. Repeated defaults and overrides are
  valid; names distinguish identities. There is no four-specialist cap or duplicate warning.
- **Each Settings option has a visible color name before selection and a 44px minimum target.**
  Radio semantics, one tab stop, arrow keys, Home/End and Space support keyboard use; selection
  and visible focus have separate rings. A successful save restores focus after rerender.
- **The Ajustes overrides are a validated closed schema** (`sanitizeOverrides`): only a customizable
  identity (the principal, or a real sub-Abito) may be keyed, and only the five palette colours may be
  values. Everything else — a provider/CLI slug, `__proto__`/`constructor`, a wrong type, an unknown
  colour name — is dropped: never applied, never thrown.
- **No specialist list is invented.** `settingsRows` returns no specialist row while no real sub-Abito
  exists, and `pi`/`claude-code`/`codex`/`opencode` are the connectors/providers the island already
  names, never sub-Abito identities.
- Checks: `node test-node/avatar-colors-check.cjs` (18), also run by `cargo test` through
  `tests/frontend_avatar_colors.rs`; the panel's model is covered by `test-node/settings-view-check.cjs`.

**How a choice reaches the Dot.** Ajustes writes it through the existing preferences command
(`prefs_action {action:"set_avatar_color",identity,color}`, validated in `src/prefs.rs` and applied by
`src/settingshost.rs` through the shared `prefs::transact` gate), `prefs.json` keeps `v: 1` and its `sound` untouched, and
the Settings controls and principal island consumer read it at boot and on every `prefs:state`.
The parent-authorized 16-line `island.js` transplant resolves only the principal preference,
never the active specialist. It sets `data-dot-color` for non-green overrides; CSS tints
only the three skin stops, retaining R6 bytes, poses and geometry. T2 reads the sole
specialist owner's immutable `identityView()` projection (`kind`, stable `id`, display `name`)
and its `abito:specialist-identities` notification; Settings never fetches/copies role
instructions or models. Actual role rows and the existing chat user icon show each identity's
color. Loading/unavailable identities have an explicit notice, not a healthy-empty claim.
Only while the specialist chip is visible, the header gives identity labels a second row
and retains all five named 44px controls in the first row at 400px and 320px. Settings
starts below both rows; principal-only header layout, island geometry and R6 stay unchanged.
A failed write is
reported beside the color controls with visible inline text and the existing aria-live announcement;
it keeps the previous colour (`save_failed`). The explanation survives rerenders, rejected retries and
pending retries, and clears only after a successful save response. The panel never announces a stored
choice it did not store.

**Verification boundary.** T2 specialist rows use the actual #327 owner projection; absent
identities are not rendered and their stored overrides remain untouched. Focus, caret and
drafts survive unrelated owner/prefs pushes. T2 checks and whole-layout screenshots are in
`evidence/integration-327-342-384/t2/` (run `node .../identity-check.cjs` and
`node .../browser-check.cjs <evidence-label>` from this worktree). The separate
`header-check.cjs <unique-label>` preserves the prior 9/10 failure and captures
320/400px top/middle/bottom before asserting containment. Its chat mock returns
`display_name`; real shipped greeting DOM is checked before and after page reload. The browser fixture serves
shipped markup/CSS and Settings/specialists modules at the default 400×640 chat geometry;
it loads all shipped scripts, opens the existing host seam with
`__islandSetState('overview')` / `__islandSetView('chat',400,640)`, and supplies IPC mocks
and trusted CDP input, not an application endpoint or model call. Reload storage is the
fixture's isolated `sessionStorage` adapter, not production `prefs.json` proof.
Chromium/CDP evidence uses an explicitly mocked IPC host,
not native Tauri/WebKitGTK or CSP proof. T1 integrates #342's preference serial gate with sound, display_name and avatar_colors.
Combined command and extracted production disk-helper checks are under
`evidence/integration-327-342-384/`; the latter adapt only AppHandle/path resolution, not
Tauri IPC or native delivery. They cover name→sound→color→reload, concurrent three-field
commits, rejected/no-op commands and failed rename without false publication. Donor browser outcomes
are not integrated/native acceptance. T2 connects identity colors, T3 handles native validation,
and T4 owns independent integrated review. No real model calls belong to T1 checks.

## #264 — the remembered position (GD049, "Persist panel position")

Inventory GD049: *"Load and save the assistant's desktop position across launches."*

- **Saved on release.** The one event that decides where the island lives is a drag
  release: `drag_release` → `ReleaseOutcome::Snapped` → `settingshost::save_position`,
  so only that outcome is persisted. A short click (toggle), a cancelled release and
  the periodic re-clamps write nothing — they never decided a placement.
- **Restored on launch.** `setup` loads `prefs.json` *before* the first geometry
  decision (`settingshost::start` runs first), then asks `geometry::restore_position`:
  if the saved origin still lies fully inside the **current** work area it is used
  verbatim; otherwise the existing M1a default (top-centre) is used. The docked
  `core.edge` is derived from the restored rectangle, so an island restored at the
  bottom still grows upward when it expands. The post-load geometry pin
  (`record_frontend_evidence`) re-pins to the same restored origin instead of
  snapping the island back to top-centre.
- **Never off-screen, never fatal.** A monitor removal, a resolution change or any
  origin outside the work area falls back to the default placement (`clamp_rect`
  equality is the "fully inside" test, so nothing half-restored is ever placed).
  Corrupt, truncated, over-bounded or wrongly typed `position` data reads as
  *no position* (→ default) and costs no other preference; a hostile value cannot
  panic (`unsigned_abs` bounds, `i32::try_from`).
- **Where it lives.** `prefs.json` stays **v1**; `position` is a new *optional*
  field (`{"x":..,"y":..}`, physical px), written only by the native drag path
  through the same `prefs::transact` gate and atomic writer as every other
  preference — so a settings change after a drag cannot drop the position and a
  drag cannot drop a settings change. A file written before #264 loads and writes
  back **byte-for-byte unchanged**.
- **Not exposed to the WebView.** `prefs::parse_command` is untouched: no payload
  can set or clear the position. `prefs::Command::SetPosition` is reachable only
  from `drag_release`, and rejects coordinates outside ±1 000 000 px.

**Verification (test-first: RED → GREEN).** RED: `cargo test --offline --locked` did not
compile — 30 errors naming exactly the API that did not exist yet (`Prefs::position`,
`Command::SetPosition`, `geometry::restore_position`, `ReleaseOutcome::saved_position`).
GREEN, same command with `CARGO_TARGET_DIR=$PWD/target`:

```sh
CARGO_TARGET_DIR="$PWD/target" cargo test --offline --locked --no-fail-fast
#   503 passed · 32 failed · 6 ignored, over 30 targets
#   lib 346 -> 356 (10 new: 5 prefs position + 4 geometry restore + 1 core save-on-release)
#   main (bin) 34, agent_daemon 14, approval_bridge 17, chat_local_model 15, daemonhost 7,
#   fixture_leaf 8, frontend_* 10, hotkey_portal 11, hotkey_x11 12, install_root 7,
#   install_script 1, models_selection 5, notice_click 4, own_window_no_wm 1,
#   packaging 1, tmpdirs 1, native_window_normal/question_producer 6 ignored, doc-tests 0
#
#   The 32 failures are PRE-EXISTING in this worktree, not from #264: question_receiver
#   (24) and transport_receiver (8) bind a Unix socket below `target/tmp`, whose path here
#   is 94 bytes against sockaddr_un's 107 -> PathTooLong / "path must be shorter than
#   SUN_LEN". Proven by re-running BOTH binaries with the #264 changes STASHED: the same
#   24 + 8 failures on the base commit e8065d4.
node test-node/*-check.cjs
#   15 of 16 exit 0; producer-check.cjs exits 2 on its usage line because it is a harness
#   (endpoint, runtime, cwd) driven by tests/transport_receiver.rs, not a standalone check
node tests/composer-ime-check.cjs   # 10 passed, 0 failed
```

Not verified here: the app was never launched on the desktop (the parent does that), so
the live drag → relaunch restore path is proven by the unit chain
(`core::release` → `saved_position` → `prefs::transact` → `geometry::restore_position`),
not by a real second launch.

## #380 — system / light / dark theme

`frontend/theme.js` owns one attribute, `<html data-theme>`, and one preference. Abito
follows the system theme by default; **Ajustes → Tema** (three radio buttons, 44 px,
arrow keys, filled + `aria-checked` when chosen) pins it to **Claro** or **Oscuro**, or
returns to **Sistema**. Full contract in `docs/theme.md`.

- **Two palettes, one design.** The dark palette is the shipped palette verbatim (every
  token is the literal that used to sit in `style.css`); the light palette is derived
  from it — same roles, same alphas over ink, warm sand surfaces from Abito's own clay.
  Role colours (`--go`, `--sun`, `--red-11`, `--island-live`, `--faint`), the Dot
  identity colours (#384), the motion policy (#304), radii, fonts and the frozen engine
  paint are never themed.
- **One closed preference.** `prefs.json` v1 gains an optional `theme` field, only
  `"system" | "light" | "dark"`; absent = system and absence is preserved, an unknown
  value reads as system, and `prefs_action` accepts exactly
  `{"action":"set_theme","theme":"dark"}` through the same sender/rate/serial gate as
  every other preference command. Refused values and failed saves change no data and
  publish no `prefs:state`.
- **Saved state is the only input to a paint.** Boot paints `system` immediately, then
  the saved mode (`prefs_action view` + every `prefs:state`); a failed save keeps the
  visible theme and says so in the panel. While the mode is `system`, exactly one
  `matchMedia('(prefers-color-scheme: dark)')` listener follows the OS; leaving
  `system` removes it, so an explicit choice can never be overridden. No polling, no
  second owner, no CSS media query, and no OS setting is ever written.
- Checks: `node test-node/theme-check.cjs` (19, real production module driven through
  fake DOM/MediaQueryList/IPC events), also run by `cargo test` through
  `tests/frontend_theme.rs`, plus `test-node/settings-view-check.cjs` and the closed
  enum/counter tests in `src/prefs_tests.rs`. Real native window appearance is
  parent-verified, not claimed by these checks.

## Layout

```
apps/desktop-tauri/
├── Cargo.toml            # normal crate; tauri v2 + single-instance + x11rb + libc/sha2 (M2)
├── build.rs              # tauri_build::build()
├── tauri.conf.json       # window contract, static frontendDist, strict CSP (M1b)
├── capabilities/main.json# least privilege: core:event listen/unlisten only (M1b)
├── run.sh                # GDK_BACKEND=x11 + cargo run
├── .gitignore            # /target/ + /.runtime*/ (M2 socket dirs, never committed)
├── tests/
│   ├── transport_receiver.rs # M2 integration: real UDS receiver + clients (+ Node producer)
│   └── approval_bridge.rs    # M3 integration: approval lane vs in-process fake backend
├── test-node/
│   └── producer-check.cjs    # drives the UNCHANGED legacy adapter.cjs (read-only) in tests
├── src/
│   ├── lib.rs            # lib target: bridge/core/desktop/geometry/workarea/protocol/transport/approval…
│   ├── bridge.rs         # PURE: payload/sender/rate gate + typed errors (+tests, RED→GREEN)
│   ├── card.rs           # PURE M3: expiry/proposals/card reason/projection/choose (+tests, RED→GREEN)
│   ├── requests.rs       # PURE M3: origin + route allowlist + login schema (+tests, RED→GREEN)
│   ├── retry.rs          # PURE M3: auth ladder — known rejections only (+tests, RED→GREEN)
│   ├── desktop.rs        # PURE: transition + snapshot shape (+tests)
│   ├── geometry.rs       # PURE: sizes, clamp, snap, grow anchor, click threshold (+tests)
│   ├── core.rs           # press/drag/release/toggle handlers shared by commands + probe (+tests)
│   ├── protocol.rs       # PURE M2: framing/validation/quota/dedupe/expiry (+tests, RED→GREEN)
│   ├── approval.rs       # M3: the lane (login read, cookie, request/authenticated/mint/poll/decide)
│   ├── http.rs           # M3: loopback HTTP/1.1 client (deadline, discard, 1 MiB, abort registry)
│   ├── fakebridge.rs     # M3: in-process fake api.py backend (tests + probe only)
│   ├── transport.rs      # M2: UDS receiver (perms, owner, quotas, cleanup) (+policy tests)
│   ├── workarea.rs       # X11 _NET_WORKAREA ∩ monitor, fallbacks
│   ├── chat.rs           # PURE U1: abito.chat.v1 turn machine, limits, prompt budget, IPC commands (+tests)
│   ├── localmodel.rs     # U1: loopback-only endpoint, SSE/chunked decoders, one-request streaming client
│   ├── chatlane.rs       # U1: preflight (no-load/no-substitute), one turn, cancel, availability
│   ├── chathost.rs       # U1: chat_action command, chat:state, overview<->chat resize
│   ├── fakemodel.rs      # U1: in-process fake llama.cpp router (tests + probe only)
│   ├── models.rs         # PURE U2: verified local registry, metadata, resource gate, listing, saved selection
│   ├── modelshost.rs     # U2: models_action command, models:state, selection → chat target
│   ├── probe.rs          # ABITO_PROBE read-back script (geometry + facade + transport + approval + chat)
│   └── main.rs           # wiring, commands, publish, lifecycle, transport/signal, approval, placement
└── frontend/
    ├── index.html        # island markup + M3 approval card (display-only)
    ├── style.css         # reused island tokens
    ├── desktop.js        # window.desktop facade over invoke/events (M1b)
    ├── island.js         # motion, pointer forwarding, notices + approval card (M2/M3), chat view motion (U1)
    ├── chat-view.js      # PURE U1 helpers (labels, send gate, announcements) — node-tested
    ├── chat.js           # U1 chat surface (composer, transcript, live region)
    ├── models.js         # U2 model picker panel (inside the chat view)
    └── clay-engine.js    # frozen R6, byte-for-byte, DO NOT EDIT
```

## M4 format A — user-local package (staged only)

Contract: `docs/desktop-packaging-plan.md`. Nothing here installs, replaces or
launches an installed app.

```sh
node packaging/build.cjs --out "$PWD/dist"   # offline release build + stage + receipt
node packaging/verify.cjs dist/abito-island/<version>   # re-hash vs receipt, no launch
```

- Build: `cargo build --release --locked --offline --features tauri/custom-protocol`
  (`custom-protocol` makes Tauri a real release: without it the binary embeds
  the build-tree path as a dev build). Gates before building: engine pin (public `checkR6`, now R7)
  (`b699ebbc…`), curated `frontend/` list, CSP without remote/unsafe sources,
  capabilities = listen/unlisten only, no `devtools`/shell/fs/http features.
- Stage: `abito-island` (release binary), `abito-island-launcher` (no args;
  refuses the whole `LD_*` family, `GDK_DEBUG`/`GTK_*` debug, WebKit inspector vars and every `ABITO_*` knob except `ABITO_PROJECT_ROOT`; forces X11),
  `com.abitog.AbitoTauri.desktop` (template, `@INSTALL_DIR@`), `receipt.json`
  (sha256 of every file, `Cargo.lock`, config, frontend, rustc, git HEAD and a
  clean-tree attestation). `build.cjs` REFUSES to build when the product paths
  have uncommitted or untracked changes: build from a clean checkout
  (`git worktree add ../abito-m4-clean <commit>`).
- Identity: `com.abitog.AbitoTauri`; installed runtime root
  `$XDG_RUNTIME_DIR/abito-island` (never `abito-desktop*`); the project root of
  an installed build comes only from `ABITO_PROJECT_ROOT` (absolute,
  normalized, existing dir) — otherwise the transport reports unavailable.
  Debug builds keep the dev layout. Tests: `tests/install_root.rs`
  (also under `cargo test --release`), `test-node/packaging-check.cjs`.
- Verified here: release build offline; identical binary hash on a rebuild at
  the same path; the verifier rejects a binary that embeds the source-tree
  path or devtools markers; a smoke run of the release binary (probe, private
  roots) reached `ready_ok: true`, 18 SVG R6 elements, exit 0. Smoke script
  (`packaging/smoke.sh <stage-dir>`) is versioned: it runs the binary with
  `ABITO_PROBE=1 ABITO_PROJECT_ROOT=<private dir> ABITO_SOCKET_DIR=<private dir>/sock`
  directly (not through the launcher, which refuses those knobs).
- NOT verified: reproducibility across different checkout paths; behaviour
  of an actually installed copy; Pi session against the new root.

## N9 — one-command install (user-local)

```sh
sh packaging/install.sh artifacts/abito-island-0.1.0-<commit>   # or dist/abito-island/<version>
sh packaging/install.sh --uninstall
```

Verifies EVERY file against `receipt.json` first (any mismatch, extra file, symlink,
non-clean provenance or foreign identity aborts without touching anything), then
installs binary + launcher + icon (+ template and receipt) into
`~/.local/share/abito-island` (`--prefix` to override) via temp-file + rename (a
running binary can be replaced), and writes
`~/.local/share/applications/com.abitog.AbitoTauri.desktop` with
`Exec=env ABITO_PROJECT_ROOT=<root> "<launcher>"`. The project root is required:
`--project-root DIR` (the folder your agent sessions run in). Idempotent; `--uninstall`
removes exactly our files and the entry. Tests: `test-node/install-check.cjs`
(11, toy stage in temp dirs). Never touches `com.abitog.Abito*` roots.

## #408 — Unified Ajustes with sub-tabs and an island that grows to fit

- **One entry:** the gear (overview and chat header) opens **Ajustes**. The separate Cuentas, Conectores and Modelo header buttons are gone; the old open events (`abito:settings-select` with a tab id) still deep-link into the matching tab.
- **Sub-tabs** (a real `role="tablist"`: arrows wrap, Home/End, roving tabindex, `aria-selected`, 44 px, visible focus): Cuentas · Conectores · Modelos · Especialistas · Pills · Apariencia · General. Names, order, icons and hints live in one table, `settings-view.js` `TABS`; rename or reorder there.
- **Where things went:** atajo + sonido → General; saludo, movimiento, tema, colores → Apariencia; the local-models picker (`#models`, same `models.js`) → Modelos.
- **Cuentas / providers (#410 r2):** one compact LIST row per provider (`providerRows`): the provider name, its status **Conectado / No conectado / En curso / Error**, and two connect buttons — `API` (manual key) and `Auth` (account sign-in) — only for a method the provider offers. Nothing else per row by default: a live login collapses the row to «Cancelar» with the device code / URL / masked prompt under it, a connected row adds «Cerrar sesión», an error or cancel stays on the row that caused it. Errors are the UI's own sentences; engine text is never rendered. Same daemon protocol and the same masked-field → `auth_reply` → cleared path; approvals stay UI-only.
- **Auto-expand (S4):** opening Ajustes calls `settings_view {open:true}`; Rust (`geometry::settings_visible`: 720 wide, height `min(680, work area − gaps)`, ≥ 240, narrower on small screens) stages the resize on the docked edge and clamps it to the work area. Closing sends `{open:false}` and the previous chat rectangle is restored. The page never sends a size; the payload is exactly one boolean. Compact and overview sizes are untouched.
- **Tests:** `test-node/settings-view-check.cjs` (tabs table, tablist keys, provider rows), `test-node/pills-check.cjs` (tab routing, size request), `src/core.rs` tests (grow, exact restore, small work areas, forget on leave) and `settingshost` payload test.

### #408 — Conexiones merge

- **Conexiones** replaces Cuentas + Conectores: «Proveedores de IA», «Agentes de código» and «Servicios» in one tab (`connectors` still resolves to it through `tabAlias`).
- **The key is write-only:** never shown back, logged, put in a view/IPC payload or sent to the WebView (`hasCredential` only). The masked editor behind «Editar» in the owned-account row is the only way to set, keep or clear it; it saves through `abito_account_create|abito_account_save|abito_account_endpoint_set` into Abito's own 0600 `accounts.json`.
- **Deleting an account:** «Quitar conexión» on the owned-account row (`abito_account_remove`) deletes the account and its key from `accounts.json`. Failure changes nothing and says so: «No se pudo quitar la conexión. No se cambió nada.»
- **No copy from Pi (#409):** there is no import of Pi's `nan` connection; the key is entered by hand in the UI. The daemon, its protocol and `desktop-daemon/src/auth.cjs` are unchanged and still never read the user's Pi credentials.
- **Tests:** `test-node/pills-check.cjs` and `settings-view-check.cjs` (no Pi card, no Pi IPC command, the owned-account row).

## #315 — Autostart + tray with states

- **Tray (Linux first):** a `tray-icon` tray (`src/trayhost.rs`) shows one of four
  shape-distinct glyphs (`src/tray.rs`, 32×32 RGBA drawn by pure pixel rules —
  clean ring / dashed ring / ring + badge dot / dimmed ring + slash, in the
  §1.1 tokens `--go`, `--island-live`, `--sun`, `--faint`). The state derives
  from the same snapshot facts the page sees (`docs/desktop-visual-language.md`
  §10.3): a pending approval card or question → *Espera tu sí*; a connection
  that is not `connected`/`working` (or a failed transport) → *No disponible*
  (unknown names fail closed); `working` → *En curso*; otherwise *Listo*.
- **Menu:** Mostrar Abito · Ocultar (the `Action::Hide` funnel) · Arrancar al
  iniciar sesión (the #315 autostart toggle) · Salir (`quit_clean`). Every
  step fails soft: a host without a working tray service runs tray-less and
  says why on stderr. Non-Unix builds compile honest no-op stubs.
- **Autostart (user-local XDG):** `src/autostart.rs` installs or removes
  `autostart/abito-island.desktop` under `$XDG_CONFIG_HOME` (default
  `$HOME/.config`), mirroring the packaging `.desktop` template (quoted
  `Exec`, unquoted `Icon`). The entry file IS the toggle's state — no
  parallel preference store; enabling is idempotent (temp file + rename,
  0644) and replaces a corrupt entry. A failed change leaves the check mark
  synced to the file system, never to the wish.
- **Tests:** `src/tray_tests.rs` (state matrix, priority, fail-closed names,
  glyph determinism and pairwise shape distinctness) and
  `src/autostart_tests.rs` (closed template, quoting/refusal rules, path
  fallback, round-trip in temp dirs, corrupt replacement, missing dir
  creation). Cargo.lock is untouched (the `tray-icon` tauri feature adds no
  packages).
## #368 / F099 — closed, gated focus of terminal / agent session / editor

- **One command, closed enum:** `focus_host` accepts exactly `{"target": "terminal" | "session" | "editor"}`. The payload never carries a command, a path or a window id, so a caller can only ask for a class of window the closed allowlists already accept (`src/focushost.rs`: `TERMINAL_CLASSES`, `EDITOR_CLASSES`, boundary-exact match — `codesign` never matches `code`).
- **Gate order mirrors `open_chat_url`:** sender → payload validation → rate limiter → effect. A rejected call returns a public Spanish reason, spends no rate budget and reaches no effect.
- **`session` semantics:** an agent-session window is a terminal-class window whose title carries the standalone agent tokens `pi` / `herdr` (token match: `pip install` is NOT a session window). A plain `terminal` ask accepts any terminal-class window; `editor` wins even when the title mentions the agent.
- **Resolution is wmctrl/xdotool-FREE:** `_NET_CLIENT_LIST_STACKING` + `WM_CLASS` + `_NET_WM_NAME` over the existing x11rb dependency; the TOPMOST match is focused with the EWMH `_NET_ACTIVE_WINDOW` client message (`set_input_focus` fallback). No process is spawned with a caller-influenced argument. On GNOME/Wayland this sees XWayland windows only; a native-Wayland window that is not found is an honest per-target Spanish reason ("No encontré una ventana de terminal/sesión de agente/editor abierta."), never a guess; a connect or activation failure is the platform reason.
- **Non-Linux** is an honest stub (the same Spanish platform reason); nothing is attempted.
- **Tests:** `src/focushost_tests.rs` — closed enum, payload shapes, gate order and budget, classification table, topmost pick, and the honest no-match / failed-activation decisions.

## #366 / F093 — the typed Ajustes placement pref

- **One optional v1 field.** `prefs.json` gains an optional `settings_window` bool (absent = the
  in-island default of #408; a non-bool stored value is dropped on load, so a hostile or damaged
  file reads as the default). `false` stores no key at all: an untouched file keeps its bytes.
- **One closed command.** `prefs_action {action:"set_settings_window", settings_window:<bool>}` —
  exactly two keys, no coercion (a number, string or null is refused and changes nothing). It
  persists through the shared `prefs::transact` gate and atomic writer like every other pref.
- **Projection.** The `prefs_action` view and the `prefs:state` event carry `settingsWindow`
  (effective bool: the default `false` when nothing is stored).
- **Where it is chosen.** Ajustes → General (added with the window itself, #366 T2); the in-island
  panel remains the default and the fallback for any window failure.
- **Tests:** `src/prefs_tests.rs` (`f093_*` — exact command shape, persistence and round-trip,
  untouched-file bytes, hostile values dropped) and `src/settingshost.rs` (`f093` projection test).

## #366 / F093 — Ajustes in its own window (opt-in)

- **One closed command.** `settings_window_action` accepts exactly `{"action":"open"|"close"}` (no URL, label or size). Gate order: sender (`bridge::sender_ok`) → shared rate limiter → payload → effect.
- **The typed pref chooses.** `open` creates or focuses the window only when `settings_window` is stored `true`; otherwise it answers `{"open":false}` and the page opens the in-island panel (#408, the default). Any command failure also falls back to the in-island panel.
- **Rust creates the window.** Label `settings`, the SAME page (`index.html`), decorated, resizable, not always-on-top. `bridge::sender_ok` and the navigation lock admit exactly the labels `main` and `settings` (exact, case-sensitive); the URL allowlist is unchanged. Closing it never quits the app.
- **Same page, window mode.** `settings.js` detects the label, sets `body[data-window="settings"]` (append-only CSS hides the island chrome) and opens Ajustes at once; closing the panel closes the window and never resizes the island.
- **Chosen in** Ajustes → General → «Abrir Ajustes en su ventana».
- **T6.2 — size (design D2).** The window opens at **960×640** (min **720×480**, logical px, scale-aware). The size it is resized to is remembered: the debounced persister (700 ms of stillness after the last resize, one background thread, no per-pixel writes) stores the logical size as the typed optional pref `settings_window_size` `{w,h}` through the SAME `prefs::transact` gate and atomic writer as every other preference. The page can never supply a size: the command is Rust-side only (`Command::SetSettingsWindowSize`, like #264's position) and the value comes only from the window's own resize event payload, read on the main thread (no window getter while a lock is held or off the main thread). Bounds 720..=3840 × 480..=2400; anything else is hostile data dropped on load; absent = the design default, never written, so an untouched `prefs.json` keeps its bytes. On open, a remembered size is used only when it fits the CURRENT work area — otherwise the 960×640 default — and whatever was chosen is clamped into the work area, never below the minimum. The in-island Ajustes keeps its existing 720×680 column.
- **Not verified here:** no GUI was launched; window creation is covered only by pure tests (payload, pref decision, gate).

## #366 / F094 — the quick panel inside the island

- **Entry.** Right-click (`contextmenu`) on either Ajustes gear opens a small popover inside the island. A normal click keeps the #408 behaviour exactly. There is no long-press. The gesture is not discoverable by itself; the human should judge whether it needs a visible hint.
- **Content.** Exactly three toggles: sound, theme (system/light/dark) and auto-close seconds, plus «Todos los ajustes» which opens the full panel.
- **No new command.** It reuses the closed `prefs_action` commands (`sound_on/off`, `set_theme` through the same `chooseTheme` sender, `set_island_interaction` with the full typed pair). The saved projection is the truth; a failed save keeps the previous value and says so. Auto-close is validated by `autoCloseProblem` before any IPC.
- **View-model.** `quickPanelView` (`settings-view.js`) reuses `themeView` and `islandInteractionView`, so the quick panel and the full panel cannot disagree. Escape, an outside click or a view change closes it. It is not built inside the settings window.
- **Tests.** `test-node/settings-view-check.cjs` (`F094`, plus a source contract). No index.html change: the panel is built from DOM nodes.
