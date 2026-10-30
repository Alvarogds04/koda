# Cues — tabla de sonidos del motor

Fuente de verdad: `CUES` en `sound-engine.js`. Un test (`test/docs.test.cjs`) analiza esta tabla y la compara con el código (id, nombre, duración, nivel y prioridad), así que no puede divergir. Los sonidos incorporados se **sintetizan** con osciladores y envolventes; no se distribuyen archivos y nunca se usan bytes de Coucou. El host puede inyectar una muestra ya decodificada con `setSample(id, bufferOrNull)`; sustituye las notas con la misma ganancia y compuertas. `clearSamples()` restaura la síntesis. Las duraciones y envolventes de esta tabla describen los cues sintetizados, no los archivos propios. Los parámetros son un punto de partida: el humano los afina de oído.

Nivel = `cue.level` (0..1). El pico real de una voz es `gain × level × note.peak`, con `gain` por defecto 0,12 y máximo 0,2. Prioridad: número mayor gana (`PRIORITY`): error 5 > attention 4 > confirm = reject 3 > notice = expired 2 > sent 1 > think = reply = listen 0 > pop -1 > open = close = peek = hover = tick = love -2.

| Id | Nombre | Disparador | Síntesis | Duración (ms) | Nivel | Prioridad |
| --- | --- | --- | --- | --- | --- | --- |
| `snd.notice` | Aviso | Aviso nuevo del transporte (settled) | dos notas senoidales suaves descendentes, 880 y 660 Hz | 250 | 0.6 | 2 |
| `snd.attention` | Atención | Tarjeta de aprobación pendiente o pregunta nueva | dos notas triangulares ascendentes, 660 y 990 Hz; la más sonora | 400 | 1 | 4 |
| `snd.confirm` | Confirmado | Acción aprobada confirmada por el host (sin trigger todavía) | golpecito brillante senoidal, 1320 Hz | 200 | 0.6 | 3 |
| `snd.reject` | Rechazado | Acción rechazada confirmada por el host (sin trigger todavía) | golpecito grave y apagado triangular, 220 Hz | 200 | 0.7 | 3 |
| `snd.error` | Error | Modelo no disponible o bloqueado, o turno con error (sólo en la transición) | dos notas triangulares descendentes, 520 y 390 Hz, sin alarmar | 350 | 0.75 | 5 |
| `snd.sent` | Enviado | Mensaje o respuesta enviados por el humano | clic ligero «soplido»: glissando senoidal agudo 2400 a 3200 Hz, nivel bajo | 150 | 0.35 | 1 |
| `snd.think` | Pensando | El modelo empieza a trabajar (una vez por turno) | un solo tono senoidal suave, 440 Hz | 250 | 0.5 | 0 |
| `snd.reply` | Respuesta | Respuesta completa (streaming a completed) | nota senoidal suave ascendente, glissando 523 a 784 Hz | 250 | 0.55 | 0 |
| `snd.listen` | Escuchando | Se abre el micrófono (sin trigger todavía) | nota corta de «listo», senoidal 740 Hz | 200 | 0.55 | 0 |
| `snd.expired` | Vencido | Pregunta o tarjeta vencida sin respuesta | nota grave muy suave, senoidal 196 Hz, nivel bajo | 200 | 0.3 | 2 |
| `snd.open` | Abrir | compact → expanded | dos senoidales rápidas ascendentes, 480 y 720 Hz | 160 | 0.22 | -2 |
| `snd.close` | Cerrar | expanded → compact o hidden | las mismas notas descendentes, 720 y 480 Hz | 160 | 0.22 | -2 |
| `snd.peek` | Asomar | hidden → compact o expanded | una nota senoidal grave suave, 280 Hz | 100 | 0.16 | -2 |
| `snd.hover` | Rozar | entrada del puntero en #clay | roce senoidal leve, 1560 Hz | 80 | 0.08 | -2 |
| `snd.pop` | Elegir | abito:cue tras elegir opción (productor pendiente) | glissando senoidal ascendente, 580 a 1160 Hz | 100 | 0.28 | -1 |
| `snd.tick` | Paso | abito:cue en progreso de adjunto o activar atajo (productor pendiente) | clic triangular muy breve, 3000 Hz | 80 | 0.1 | -2 |
| `snd.love` | Cariño | hover continuo de 1900 ms | arpegio senoidal suave, 600, 750 y 900 Hz | 290 | 0.2 | -2 |

`desktop:state` contiene el snapshot del host: `payload.state` es exactamente `compact`, `expanded` o `hidden`.
La primera observación válida sólo fija una línea base. `hidden → expanded` produce **peek solamente**, no open.
Reconnect y `visibilitychange` visible reinician la línea base y abren 3000 ms de silencio.
El observador de `#clay` sólo mira `style` / `--hover > 1`; no escucha poses. Hover suena una vez por entrada
(límite del motor: 2 s por id); love intenta sonar una vez por entrada tras 1900 ms, como máximo una vez cada 6000 ms.
Salir cancela el temporizador; no hay reintentos diferidos. Sin #clay no hay observador ni temporizador de hover.
`wire().dispose()` desconecta observadores, temporizadores y suscripciones; no cierra el motor compartido.

Productores futuros (no instalados por el adaptador):
```js
document.dispatchEvent(new CustomEvent('abito:cue', { detail: 'snd.pop' }));
document.dispatchEvent(new CustomEvent('abito:cue', { detail: 'snd.tick' }));
```
El evento se emite sobre `document`, `detail` es el id string exacto (no `{id: ...}`); no requiere bubbling.
Todos los cues pasan por preferencias, ganancia, quiet, prioridad y límites del motor.

## Reglas que no están en la tabla

- Todas las notas tienen ataque >= 5 ms y una rampa de relajación >= 15 ms hasta ~0 antes de `stop` (sin clics); nunca se hace una rampa desde o hacia 0 (se usa 0,0001).
- Duración 80..600 ms por cue (ninguno > 900 ms). Límite global: un commit al grafo cada 250 ms, el mismo cue una vez cada 2 s, como mucho 3 voces vivas. Los sobrantes se descartan, nunca se encolan. Si la reanudación del contexto se demora, las compuertas y el limitador se comprueban otra vez al reanudar; ambos tiempos se miden desde el instante del commit, no desde la petición.
- No suenan nunca «Enviada» ni «Sin confirmar».
