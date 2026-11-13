# Probar Koda en tu Mac (versión 0.1.0)

Koda es una isla chiquita arriba de la pantalla que muestra qué están haciendo tus agentes (**Claude Code**, **Codex** y **Pi**) y te deja contestarles sin ir a la terminal. Antes se llamaba **Abito**.

Necesitás una Mac con **Apple Silicon (M1 o más nuevo)** y **macOS 12 o superior**. En una Mac con Intel no abre.

## 1. Bajar e instalar

1. Desde https://github.com/Alvarogds04/koda/releases bajá `Koda-macos-arm64.dmg`.
2. Abrí el `.dmg` y arrastrá la app a **Aplicaciones** (en el Finder se ve como **Koda**).

Si tenías Abito instalado, instalá Koda encima: se conservan tus ajustes, cuentas y hooks.

## 2. Abrirla la primera vez

La app **no está notarizada por Apple** (eso cuesta 99 USD al año), así que macOS la frena la primera vez. Es normal.

1. Abrila desde **Aplicaciones**. macOS va a decir que no se puede verificar el desarrollador: tocá **Listo** (o **Cancelar**).
2. Abrí **Ajustes del Sistema → Privacidad y seguridad** y bajá hasta el aviso sobre la app.
3. Tocá **Abrir igualmente** y confirmá con tu contraseña o Touch ID.

A partir de ahí abre normalmente.

**Si macOS dice que la app «está dañada»:** abrí la Terminal y ejecutá

```sh
xattr -dr com.apple.quarantine /Applications/Koda.app
```

y volvé a abrirla. (La app se llama `Koda.app` tanto en el Finder como en el disco).

## 3. Node.js y Pi

Koda usa Node.js para manejar los agentes, y Pi para el chat. **No hace falta instalarlos a mano:**

- Koda encuentra el Node.js que ya tengas (Homebrew, nvm, Volta o fnm), aunque la Terminal no lo cargue.
- Si no hay Node.js, **Ajustes → Agentes** ofrece **«Descargar e instalar Node.js»**: baja el instalador oficial de nodejs.org, comprueba que es el original y lo abre; vos tocás instalar.
- Para Pi, usá **«Instalar Pi»** en la fila de Pi de **Ajustes → Agentes**.

Sin Node.js o Pi, Koda igual abre y los avisos funcionan; Ajustes dice qué falta.

## 4. Dónde está

- La **isla** aparece arriba, en el centro de la pantalla.
- **No hay ícono en el Dock**: es a propósito. Para mostrarla, ocultarla o salir, usá el ícono de Koda en la **barra de menú** (arriba a la derecha).

## 5. Conectar tus agentes

- **Claude Code y Codex:** en **Ajustes → Agentes**, tocá **Instalar…**. Koda instala sus hooks.
- **Pi:** instalá la extensión desde **Ajustes → Agentes**. Si tenías Pi abierto, **cerralo y abrilo de nuevo** para que la tome.

Después, abrí una sesión de tu agente: cuando te pida permiso o te haga una pregunta, aparece en la isla.

## 6. Permisos de macOS

- **Micrófono:** solo si usás el dictado (está en pausa en esta versión).
- **Accesibilidad / Automatización:** solo si macOS la pide para un atajo. Si no la pide, no hace falta.

## 7. Checklist (marcá: anda / no anda / no aplica)

- [ ] Abre (después de «Abrir igualmente») y se ve la isla arriba.
- [ ] No aparece en el Dock y sí en la barra de menú; desde ahí se puede mostrar, ocultar y salir.
- [ ] **Ajustes** dice la versión **0.1.0**.
- [ ] **Ajustes → Agentes:** encuentra Node.js (o ofrece instalarlo) y deja instalar Claude Code, Codex y Pi.
- [ ] Una pregunta o pedido de permiso de tu agente aparece en la isla, con Koda, y lo podés contestar desde ahí.
- [ ] Cerrar y volver a abrir: se conservan los ajustes.
- [ ] Desinstalar: arrastrar la app de Aplicaciones a la Papelera.

## 8. Qué mandarme

- **Capturas** de lo que falle y de cualquier cartel de macOS.
- El reporte de la app: **Ajustes → «Reportar un problema»**.
- Tu modelo de Mac y versión de macOS.

¡Gracias por probarla!
