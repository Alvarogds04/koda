# Sonidos de Koda

Koda suena cuando un agente te avisa de algo. Cada aviso tiene su propio sonido, y puedes reemplazar cualquiera con un archivo tuyo.

## Qué suena y cuándo

| Aviso | Sonido | Nombre del archivo propio |
| --- | --- | --- |
| Un agente te hace una pregunta | Pregunta | `question` |
| Un agente te pide permiso (para ejecutar un comando, por ejemplo) | Aprobación pendiente | `approval` |
| Un agente terminó su turno | Terminado | `finish` |
| Un agente te pregunta en su propia terminal, o se corta la conexión con los agentes | Aviso | `notice` |
| Una pregunta venció sin respuesta | Vencido | `expired` |

Un aviso suena sólo **cuando llega**. No suena:

- lo que ya estaba en la isla al abrir Koda;
- lo que vuelve a aparecer tras una reconexión;
- cuando descartas un aviso o respondes una pregunta.

## Apagar el sonido

**Ajustes → General → Sonido.** Con el sonido apagado no suena ningún aviso, y Koda tampoco abre el audio ni lee tus archivos. El control **Volumen** del mismo lugar regula todos los sonidos.

## Poner tu propio sonido

1. Abre **Ajustes → General** y pulsa **Abrir la carpeta de sonidos**. La carpeta se crea en ese momento si aún no existe.
2. Copia ahí un archivo con el **nombre del sonido** que quieras reemplazar, por ejemplo `question.wav`, `approval.mp3` o `finish.ogg`.
3. Pulsa **Recargar sonidos**. Desde ese momento ese aviso suena con tu archivo.

Para volver al sonido de Koda, borra o renombra tu archivo y pulsa **Recargar sonidos**.

### La carpeta en cada sistema

Es la carpeta `sounds` dentro de la carpeta de configuración de Koda (identificador `com.abitog.AbitoTauri`):

| Sistema | Carpeta |
| --- | --- |
| Linux | `~/.config/com.abitog.AbitoTauri/sounds` (o `$XDG_CONFIG_HOME/com.abitog.AbitoTauri/sounds` si defines `XDG_CONFIG_HOME`) |
| macOS | `~/Library/Application Support/com.abitog.AbitoTauri/sounds` |
| Windows | `%APPDATA%\com.abitog.AbitoTauri\sounds` (es decir, `C:\Users\<tú>\AppData\Roaming\com.abitog.AbitoTauri\sounds`) |

**Abrir la carpeta de sonidos** la muestra en el gestor de archivos: Finder en macOS, el Explorador en Windows y el gestor predeterminado (`xdg-open`) en Linux. Si el gestor no responde, ábrela a mano con la ruta de la tabla.

### Nombres

El nombre (sin extensión) tiene que ser exactamente uno de los de la tabla de arriba, en minúsculas. Koda ignora cualquier otro nombre. Los demás sonidos de Koda también admiten archivo propio con su nombre: `error`, `sent`, `think`, `reply`, `open`, `close`, `peek`, `hover`, `pop`, `tick` y `love`, entre otros.

### Formatos

Extensiones admitidas: `.wav`, `.mp3`, `.ogg`, `.oga`, `.m4a`, `.aac`, `.flac`, `.aiff`, `.aif` y `.caf`. Si hay varios archivos con el mismo nombre, gana el primero de esta lista (`question.wav` antes que `question.mp3`).

Lo que de verdad se puede reproducir depende del sistema. `.wav` y `.mp3` funcionan en los tres. En Linux, `.m4a` y `.aac` necesitan los complementos de GStreamer de tu distribución.

### Límites

- **2 MiB** como máximo por archivo. Uno más grande se ignora.
- Un archivo vacío, una carpeta o un enlace simbólico con ese nombre también se ignoran.
- Si tu archivo no se puede leer o decodificar, ese aviso suena con el sonido de Koda. Un archivo dañado nunca deja a Koda en silencio.
- Un sonido largo se corta solo: Koda no reproduce más de tres sonidos a la vez y no repite el mismo sonido antes de 2 segundos.
