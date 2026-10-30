# abito-desktop-sound — motor de sonido de la isla (#313)

Un único archivo UMD sin dependencias, `sound-engine.js`, que sintetiza los 17 cues del catálogo (`docs/desktop-sound-catalog.md`) con un subconjunto de WebAudio (osciladores y ganancias). **Sin acceso a archivos, sin DOM, sin red.** Admite muestras opcionales ya decodificadas, inyectadas por el host; sin ellas usa la síntesis propia. Apagado por defecto. Parámetros por cue: `docs/CUES.md`.

Este paquete no toca `apps/desktop-tauri`; el carril de Tauri integra según este contrato.

## Cargar

Los módulos del frontend de Tauri son scripts clásicos. `sound-engine.js` expone `window.AbitoSound` (congelado) y, en Node, `module.exports`.

1. Copiar `sound-engine.js` a `apps/desktop-tauri/frontend/` (vendorizado: desktop-tauri empaqueta sólo `frontend/`).
2. Añadir `<script defer src="sound-engine.js"></script>` **antes** de `island.js`. La CSP `script-src 'self'` lo permite.
3. El carril debe añadir un test que compare el `sha256` de la copia vendorizada con este archivo fuente, para que no diverjan.

## Preferencias

`prefs:state` llega con `{v:1, sound:bool}`. Se aplica tal cual:

```js
engine.applyPrefs(payload); // true sólo con un objeto plano {v:1, sound:true}
```

Ausente, corrupto, `v` distinto de 1 o `sound` no booleano: **APAGADO** (devuelve `false`). La ganancia aún no se persiste (`prefs.json` sólo tiene `sound`): por defecto 0,12, `setGain()` acota a [0, 0,2] y un valor no finito vuelve a 0,12. Ganancia 0 equivale a apagado (sin crear contexto).

## Reglas de arranque

- `engine.ready()` sólo **después** de renderizar el primer snapshot de estado. Antes de eso no suena nada («sin sorpresas al arrancar»).
- Al reconectar, reanudar o reproducir un historial: `engine.quiet(ms)` (0..60000) y `engine.resetTransitions()`. Tras `resetTransitions()` la siguiente observación de cada clave vuelve a ser sólo una línea base.
- `transition(key, active, id)`: la **primera** observación de una clave sólo graba la línea base (una condición persistente ya presente al arrancar no suena); después suena `id` únicamente en el paso false a true; true a false sólo rearma. `active` debe ser booleano estricto. Claves: texto de <= 64 caracteres, mapa acotado a 256 (se expulsa la más antigua).
- El motor no crea ningún AudioContext mientras está apagado (lo solicita en el primer play permitido; si falla: `no_audio` y no se reintenta durante 10 s). El cableado de la isla puede crear el contexto compartido al arrancar para decodificar archivos propios, sin reproducirlos, incluso con sonido apagado.

## Ejemplo completo

```js
const engine = AbitoSound.createSoundEngine({
  enabled: false,                 // el contrato de la isla es el silencio
  isActive: () => !sessionLocked, // punto de inyección; ver «No verificado»
  onDiagnostic: (reason) => console.debug('sound:', reason),
});
window.addEventListener('prefs:state', (e) => engine.applyPrefs(e.detail)); // adaptar al bus real
render(firstSnapshot);
engine.ready();

function onReconnect() { engine.quiet(3000); engine.resetTransitions(); }

// eventos de la isla
engine.transition('model-error', model.state === 'unavailable' || model.state === 'blocked', 'snd.error');
engine.play('snd.sent');
```

### Cableado con el evento de página `abito:cue` (diseño del carril Tauri)

La detección de eventos vive en la página (`notify.js`, `chat.js`, `island.js`) y termina en `document.dispatchEvent(new CustomEvent('abito:cue', { detail: id }))`. El módulo sólo convierte ese id en audio:

```js
document.addEventListener('abito:cue', (e) => { engine.play(e.detail); }); // fire-and-forget: nunca lanza ni rechaza
```

El motor acepta únicamente los 17 ids del catálogo (cualquier otro valor, incluidos `__proto__` o no strings, resuelve `unknown_cue`) y mantiene su propio limitador como segunda línea (250 ms global, 2 s por id, prioridad `error` > `attention` > `confirm`/`reject` > `notice`/`expired` > `sent` > `think`/`reply`/`listen` > `pop` > `open`/`close`/`peek`/`hover`/`tick`/`love`). Por eso `sent` seguido de `think` a menos de 250 ms suena como `sent` y descarta `think`, tal como pide `odd/tasks/island-sounds.md`; no se fusionan ni se encolan.

**Modo de fallo más probable: el silencio.** El motor arranca APAGADO y NO REPRODUCE NADA hasta que se cumplan las dos condiciones: `applyPrefs({v:1,sound:true})` (o `setEnabled(true)`) **y** `ready()`. Si el cableado olvida una de las dos, todos los `play()` resuelven `disabled` o `not_ready` sin error. Durante la integración conviene pasar `onDiagnostic` y comprobar `engine.state()`.

`play(id)` siempre devuelve `Promise<{played, reason, id}>`, incluso si se rechaza por una compuerta; la promesa **nunca rechaza**. `transition(...)` devuelve esa promesa sólo cuando una transición false→true solicita un cue; en otro caso devuelve `undefined`. Ningún método lanza excepciones al host.

### Valores de retorno exactos

- `ready()`, `quiet(ms)`, `setEnabled(v)`, `setGain(n)`, `resetTransitions()` y `close()` devuelven `undefined`.
- `applyPrefs(prefs)` devuelve `boolean`.
- `isEnabled()` devuelve `boolean`.
- `state()` devuelve un `object` con `enabled`, `gain`, `ready`, `quietUntil` y `closed`.
- `play(id)` siempre devuelve `Promise<{played, reason, id}>`.
- `transition(key, active, id)` devuelve `Promise<{played, reason, id}>` cuando solicita un cue; en otro caso devuelve `undefined`.

`engine.close()` detiene todo y cierra el contexto.

## Muestras propias opcionales (#467)

`engine.setSample(id, bufferOrNull)` acepta sólo los diecisiete ids del catálogo y un AudioBuffer-like con `duration` finita positiva y `getChannelData()`; devuelve `true` al instalarlo o quitarlo con `null`, `false` ante valores inválidos o motor cerrado. No decodifica ni lee archivos. `engine.clearSamples()` quita todas las muestras (devuelve `undefined`); `close()` también las libera. Ninguno lanza excepciones.

Una muestra sustituye las notas, no las compuertas: apagado, ready, quiet, inactive, prioridad, duplicados, ritmo y máximo de tres voces siguen iguales. Se conecta por ganancia `gain × cue.level`, y se detiene/desconecta con el mismo ciclo de vida que la síntesis. La duración de la muestra es la del archivo decodificado, no la de las notas del catálogo.

En Tauri, `frontend/sound-wiring.js` obtiene `sound_action {action:'list'}` al arrancar y por cada `sounds:changed`; sólo lee los diecisiete stems conocidos mediante `{action:'read',name}`. Valida base64 no vacío de hasta 2 MiB, decodifica con el AudioContext compartido del motor e inyecta el buffer. Los reloads se serializan; cada uno borra las muestras anteriores, así que una eliminación o fallo de lectura/decodificación vuelve al cue sintetizado. Sin invoke o AudioContext no registra el lector. No se distribuyen archivos de audio ni bytes de Coucou.

## API

`createSoundEngine(options)`: `createContext`, `enabled` (false), `gain` (0,12), `isActive` (() => true), `now`, `setTimer`/`clearTimer`, `coalesceMs` (25), `cues` (sobrescrituras validadas), `onDiagnostic`. Métodos: `ready`, `quiet`, `setEnabled`, `applyPrefs`, `setGain`, `isEnabled`, `state`, `play`, `transition`, `resetTransitions`, `setSample`, `clearSamples`, `close`. Estáticos congelados: `CUES`, `CUE_IDS`, `PRIORITY`, `DEFAULT_GAIN`, `MAX_GAIN`, `REASONS`, `DIAGNOSTICS`.

### Conjunto cerrado de razones

Orden de comprobación en `play()`: `closed`, `unknown_cue`, `disabled`, `not_ready`, `quiet`, `inactive`, y después el limitador.

| Razón | Significado |
| --- | --- |
| `played` | Programado. |
| `disabled` | Sonido apagado (o ganancia 0). |
| `not_ready` | Falta `ready()`. |
| `quiet` | Ventana de `quiet()` activa. |
| `inactive` | `isActive()` devolvió false (o lanzó). |
| `unknown_cue` | El id no es una clave propia de `CUES`. |
| `rate_limited` | El commit de otro cue fue hace menos de 250 ms, o ya hay 3 voces. |
| `duplicate` | El commit del mismo cue fue hace menos de 2 s (o se repitió dentro de una ráfaga). |
| `outranked` | En la misma ráfaga ganó otro cue de mayor prioridad (empates: gana el primero). |
| `no_audio` | No se pudo crear o usar el contexto. |
| `closed` | El motor está cerrado. |

Limitador global: nunca encola ni interrumpe; los cues pedidos con menos de `coalesceMs` entre sí se agrupan y gana el de mayor prioridad (error > attention > confirm = reject > notice = expired > sent > think = reply = listen > pop > open = close = peek = hover = tick = love). Si un contexto suspendido tarda en reanudarse, al terminar la espera acotada se vuelven a comprobar todas las compuertas y el limitador; los tiempos de 250 ms y 2 s se estampan en el instante del commit al grafo, no al recibir la petición.

### Diagnósticos

`onDiagnostic(reason)` sólo recibe cadenas de `DIAGNOSTICS`: `invalid_cue_override`, `no_audio`, `context_error`, `is_active_error`. Una excepción del callback se traga. Una sobrescritura de `options.cues` inválida se ignora para ese cue (límites estrictos: f 40..4000 Hz, dur 0,02..0,6 s, total <= 0,9 s, ataque 0,005..0,3 s, relajación 0,015..0,3 s, peak/level 0..1, tipos `sine`|`triangle`, <= 6 notas).

## Evento a cue (eventos de la isla tal como existen hoy)

| Evento de la isla | Cue | Notas |
| --- | --- | --- |
| Pregunta nueva | `snd.attention` | Sólo cuando aparece (id nuevo). |
| Vencimiento de pregunta o tarjeta | `snd.expired` | |
| Cara de error (modelo no disponible/bloqueado, o error de turno) | `snd.error` | **Sólo en la transición** con `transition()`; nunca mientras dura. |
| Mensaje enviado | `snd.sent` | |
| Respuesta completa (streaming a completed) | `snd.reply` | |
| Empieza a pensar | `snd.think` | Una vez por turno. |
| Aviso que no es pregunta (settled) | `snd.notice` | |
| Acción aprobada confirmada | `snd.confirm` | sin trigger todavia: espera el campo tipado del host. |
| Acción rechazada confirmada | `snd.reject` | sin trigger todavia: espera el campo tipado del host. |
| Micrófono abierto | `snd.listen` | sin trigger todavia: espera la voz. |

No se inventan disparadores para los tres últimos.

### Interacciones de la isla (#467, decisión L42)

Los siete cues adicionales son síntesis original de Abito, sin WAV ni muestras de Coucou.
Parámetros completos (duración, nivel y prioridad): `docs/CUES.md`.

| Cue | Evento | Estado del productor |
| --- | --- | --- |
| `snd.open` | `desktop:state`, compact → expanded | Adaptador instalado. |
| `snd.close` | `desktop:state`, expanded → compact o hidden | Adaptador instalado. |
| `snd.peek` | `desktop:state`, hidden → compact o expanded | Adaptador instalado; nunca duplica open. |
| `snd.hover` | `#clay` style `--hover` cruza de <=1 a >1 | Observador instalado; una vez por entrada, limitado a 2 s por id. |
| `snd.love` | Hover continuo durante 1900 ms | Una vez por entrada, como máximo una cada 6000 ms. Salir cancela. |
| `snd.pop` | Elegir modelo/proveedor u otra opción | Sólo `abito:cue`; productor pendiente. |
| `snd.tick` | Progreso de adjunto o activar atajo | Sólo `abito:cue`; productor pendiente. |

El payload Tauri es un snapshot con `state` exactamente `compact`, `expanded` o `hidden`, no `view` ni la fase CSS animada.
El primer snapshot válido es silencioso. Reconectar o volver a visible reinicia esa línea base, cancela el dwell
y abre 3000 ms de quiet; no se reproduce historia. Un peek concurrente con notice pierde por prioridad.
Los nuevos cues tienen prioridad -2, excepto pop (-1); todos quedan por debajo de los cues semánticos existentes.
Hover/tick duran 80 ms, el mínimo del contrato de síntesis, con una caída rápida y suave.
Sin `#clay` no se instala observador ni temporizador de hover. `wire({now, setTimer, clearTimer, MutationObserver})`
permite pruebas deterministas; `wire().dispose()` libera observadores, temporizadores y suscripciones, no el motor.

Contrato exacto de los hooks futuros (emitir sobre `document`; `detail` es un string, no objeto; sin bubbling):
```js
// Tras aceptar una selección de modelo/proveedor en island/chat:
document.dispatchEvent(new CustomEvent('abito:cue', { detail: 'snd.pop' }));
// En un cambio de progreso de adjunto / al activar un atajo:
document.dispatchEvent(new CustomEvent('abito:cue', { detail: 'snd.tick' }));
```
No se modifican esos productores en este carril. Las preferencias sound=false y gain=0 silencian también estas
interacciones; la ganancia del usuario se aplica como `gain × cue.level`. Los stems de override nuevos son
`open`, `close`, `peek`, `hover`, `pop`, `tick`, `love`; requieren la ampliación paralela de STEMS en Rust por el padre.

### Lo que NUNCA debe sonar

- **«Enviada»** (la decisión se envió y el host contestó 2xx).
- **«Sin confirmar»** (conflicto al confirmar): no es un error; la tarjeta ya cuenta con `snd.attention`.
- Nada por el solo cambio de cara del personaje, ni al arrancar, reanudar o reconectar.

## No verificado (honesto)

- La **salida de audio real en WebKitGTK** dentro de Tauri (GStreamer, latencia): no se probó. Los tests usan un AudioContext de software determinista (`test/support/soft-audio.cjs`); nunca se reproduce audio real.
- La **detección de pantalla bloqueada / no molestar** de GNOME: `isActive` es sólo un punto de inyección; no hay detector.
- Que los parámetros resulten agradables: el humano los aprueba escuchando. `node scripts/render-wav.cjs <dir-absoluto-fuera-del-repo>` escribe un WAV por cue (con el mismo motor y el contexto de software) para auditionarlos; rechaza rutas relativas o dentro del repositorio. El repositorio no contiene archivos de audio (hay un test que lo vigila).

## Tests

`npm test` (node:test, sin dependencias).
