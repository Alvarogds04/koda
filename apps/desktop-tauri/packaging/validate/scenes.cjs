'use strict';
const hubPages = require('./pages.json');
const extraScenes = ['chat-contexto-ventana', 'ajustes-contexto-sin-extension', 'avisos-ciclo', 'isla-ausencia', 'isla-borde-regreso', 'integraciones-estados', 'isla-hover-pin-ocultar', 'dictado-historial', 'dictado-repegar', 'ajustes-arranque-apagado', 'ajustes-arranque-manual', 'ajustes-arranque-login', 'atajos-chat-alerta-terminal-sonido', 'atajos-catalogo', 'atajos-grabar-borrar', 'integracion-github', 'correo-keyring', 'spotify-reproductor', 'sonidos-controles', 'sonidos-audible', 'dictado-sin-modelo', 'voz-sin-modelo', 'voz-reconocimiento', 'bandeja-menu', 'autoinicio', 'personaje-escritorio', 'chat-segundo-turno', 'dictado-inactivo', 'sesiones-motor', 'github-detalle', 'spotify-artwork-fallback', 'sesiones-foco-pildoras', 'sin-motor-sin-productor', 'sin-motor-con-productor', 'pi-aviso', 'pi-pregunta', 'ajustes-engranaje', ...hubPages.map(p => `ajustes-${p}`), 'ajustes-cuentas-keyring'];
function classify(observation) {
  const o = observation || {};
  if (o.ok !== true || o.errors?.length) return { verdict: 'fail', reason: o.reason || o.errors?.join('; ') || 'falta evidencia de comportamiento', evidence: o };
  if (o.unverifiable) return { verdict: 'unverifiable', reason: o.unverifiable, evidence: o };
  return { verdict: 'pass', evidence: o };
}
module.exports = { hubPages, extraScenes, classify };
