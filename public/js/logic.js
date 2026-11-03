// Lógica pura de la plataforma: no usa el DOM ni IndexedDB, así se puede probar con `node --test`
// y reutilizar en el servidor.

export const AREAS = ['Matemáticas', 'Lenguaje', 'Ciencias Naturales', 'Ciencias Sociales', 'Inglés', 'Tecnología'];

// Lecturas de menos de este tiempo se consideran aperturas accidentales y no se registran (RF04).
export const SEGUNDOS_MINIMOS_LECTURA = 3;

export function crearId(prefijo = 'id') {
  const aleatorio = Math.random().toString(36).slice(2, 8);
  return `${prefijo}-${Date.now().toString(36)}-${aleatorio}`;
}

/** Crea el evento de lectura que se guarda localmente, o null si la lectura fue demasiado corta. */
export function crearEventoLectura({ usuario, recurso, inicio, fin, sinConexion }) {
  const segundos = Math.round((fin - inicio) / 1000);
  if (!usuario || !recurso || segundos < SEGUNDOS_MINIMOS_LECTURA) return null;
  return {
    id: crearId('ev'),
    usuarioId: usuario.id,
    usuarioNombre: usuario.nombre,
    grado: usuario.grado ?? null,
    recursoId: recurso.id,
    recursoTitulo: recurso.titulo,
    area: recurso.area,
    inicio: new Date(inicio).toISOString(),
    segundos,
    sinConexion: Boolean(sinConexion),
    sincronizado: false,
  };
}

export function pendientesDeSincronizar(eventos) {
  return eventos.filter((e) => !e.sincronizado);
}

/** Divide los pendientes en lotes pequeños para no saturar redes de bajo ancho de banda (RNF04). */
export function lotes(items, tamano = 25) {
  const out = [];
  for (let i = 0; i < items.length; i += tamano) out.push(items.slice(i, i + tamano));
  return out;
}

/** Quita del evento los campos que solo tienen sentido en el dispositivo, para enviar menos datos. */
export function compactarEvento(e) {
  const { sincronizado, ...resto } = e;
  return resto;
}

/** Une eventos sin duplicar por id; el servidor lo usa para que reenviar un lote no cuente dos veces. */
export function unirEventos(existentes, nuevos) {
  const vistos = new Set(existentes.map((e) => e.id));
  const agregados = [];
  for (const e of nuevos) {
    if (!e || typeof e.id !== 'string' || vistos.has(e.id)) continue;
    vistos.add(e.id);
    agregados.push(e);
  }
  return { todos: existentes.concat(agregados), agregados };
}

export function resumenActividad(eventos) {
  const porRecurso = new Map();
  let segundos = 0;
  let sinConexion = 0;
  const estudiantes = new Set();
  for (const e of eventos) {
    segundos += e.segundos;
    if (e.sinConexion) sinConexion += 1;
    estudiantes.add(e.usuarioId);
    const r = porRecurso.get(e.recursoId) ?? { recursoId: e.recursoId, titulo: e.recursoTitulo, area: e.area, lecturas: 0, segundos: 0 };
    r.lecturas += 1;
    r.segundos += e.segundos;
    porRecurso.set(e.recursoId, r);
  }
  return {
    lecturas: eventos.length,
    segundos,
    lecturasSinConexion: sinConexion,
    estudiantes: estudiantes.size,
    recursos: [...porRecurso.values()].sort((a, b) => b.lecturas - a.lecturas || b.segundos - a.segundos),
  };
}

export function formatearDuracion(segundos) {
  if (segundos < 60) return `${segundos} s`;
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = segundos % 60;
  if (h > 0) return `${h} h ${m} min`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function agruparPorArea(recursos) {
  const grupos = new Map();
  for (const r of recursos) {
    if (!grupos.has(r.area)) grupos.set(r.area, []);
    grupos.get(r.area).push(r);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => indiceArea(a) - indiceArea(b))
    .map(([area, items]) => ({ area, recursos: items.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')) }));
}

function indiceArea(area) {
  const i = AREAS.indexOf(area);
  return i === -1 ? AREAS.length : i;
}

/** Valida un recurso publicado por un docente (HU02). Devuelve la lista de errores. */
export function validarRecurso(r) {
  const errores = [];
  if (!r || typeof r !== 'object') return ['El recurso no es válido.'];
  if (!r.titulo || r.titulo.trim().length < 4) errores.push('El título debe tener al menos 4 caracteres.');
  if (!AREAS.includes(r.area)) errores.push('Selecciona un área de conocimiento válida.');
  if (!r.grado) errores.push('Indica el grado al que va dirigido.');
  if (!r.contenido || r.contenido.trim().length < 20) errores.push('El contenido debe tener al menos 20 caracteres.');
  return errores;
}

/** Normaliza el texto que escribe el docente: un párrafo por cada línea en blanco. */
export function parrafos(contenido) {
  return contenido
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Tamaño aproximado en KB de un recurso, para mostrar cuánto ocupa al guardarlo sin conexión. */
export function tamanoKB(recurso) {
  const bytes = new TextEncoder().encode(JSON.stringify(recurso)).length;
  return Math.max(1, Math.round(bytes / 1024));
}
