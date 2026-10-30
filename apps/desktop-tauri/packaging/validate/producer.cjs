'use strict';
// Missing evidence from a failed fixture is a failure, not a timeout and not an
// environmental limitation. Do not overwrite observations already delivered.
const dependentScenes = ['sin-motor-con-productor', 'pi-aviso', 'avisos-ciclo', 'atajos-chat-alerta-terminal-sonido', 'pi-pregunta'];
function producerFailures(reason, rows) {
  const completed = new Set(rows.map(row => row.name));
  return dependentScenes.filter(name => !completed.has(name)).map(name => ({
    name, verdict: 'fail', reason: `productor Pi: ${reason || 'error sin detalle'}`,
  }));
}
module.exports = { producerFailures };
