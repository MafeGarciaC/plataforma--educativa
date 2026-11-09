import * as db from './db.js';
import {
  AREAS, crearId, crearEventoLectura, pendientesDeSincronizar, lotes, compactarEvento,
  resumenActividad, formatearDuracion, agruparPorArea, validarRecurso, parrafos,
} from './logic.js';

const GRADOS = ['1°', '2°', '3°', '4°', '5°', '6°', '7°', '8°', '9°', '10°', '11°'];
const CLAVE_SESION = 'aula-sesion';
const CLAVE_SIMULADO = 'aula-sin-red-simulado';
const CLAVE_PANEL = 'aula-ultimo-panel';

let vista = document.getElementById('vista');
const menu = document.getElementById('menu');
const botonRed = document.getElementById('estado-red');
const botonInstalar = document.getElementById('instalar');
const aviso = document.getElementById('aviso');

let sesion = leerLocal(CLAVE_SESION);
let lecturaActual = null;
let sincronizando = false;
let pendientes = 0;

// ---------- utilidades ----------
function leerLocal(clave) {
  try { return JSON.parse(localStorage.getItem(clave)); } catch { return null; }
}
function escribirLocal(clave, valor) {
  try {
    if (valor === null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, JSON.stringify(valor));
  } catch { /* almacenamiento bloqueado: la app sigue funcionando sin recordar este dato */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function avisar(texto) {
  aviso.textContent = texto;
  aviso.classList.add('visible');
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => aviso.classList.remove('visible'), 2800);
}

const simulado = () => leerLocal(CLAVE_SIMULADO) === true;
// El navegador puede tener red y aun así no llegar al servidor (wifi sin internet), por eso se recuerda el último intento.
let servidorAlcanzable = true;
const enLinea = () => navigator.onLine && !simulado() && servidorAlcanzable;

class SinConexion extends Error {}

function marcarServidor(alcanzable) {
  if (servidorAlcanzable === alcanzable) return;
  servidorAlcanzable = alcanzable;
  pintarEstado();
}

async function api(ruta, opciones = {}) {
  if (!navigator.onLine || simulado()) throw new SinConexion('Sin conexión');
  let resp;
  try {
    resp = await fetch(ruta, { ...opciones, headers: { 'Content-Type': 'application/json', ...opciones.headers } });
  } catch {
    marcarServidor(false);
    throw new SinConexion('Sin conexión');
  }
  const cuerpo = await resp.json().catch(() => ({}));
  const sinRed = resp.headers.get('X-Desde-Cache') === '1' || (resp.status === 503 && cuerpo.error === 'Sin conexión');
  marcarServidor(!sinRed);
  if (sinRed) throw new SinConexion('Sin conexión');
  if (!resp.ok) throw Object.assign(new Error(cuerpo.error || 'Error del servidor'), { cuerpo, estado: resp.status });
  return cuerpo;
}

const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

// ---------- estado de red y sincronización (RF05) ----------
async function contarPendientes() {
  const [eventos, salida] = await Promise.all([db.todos('eventos'), db.todos('salida')]);
  pendientes = pendientesDeSincronizar(eventos).length + salida.length;
  pintarEstado();
}

function pintarEstado() {
  const online = enLinea();
  botonRed.classList.toggle('sin-red', !online);
  const base = online ? 'En línea' : simulado() ? 'Sin conexión (simulado)' : 'Sin conexión';
  botonRed.textContent = pendientes ? `${base} · ${pendientes} por sincronizar` : base;
  botonRed.title = simulado() ? 'Volver a usar la conexión real' : 'Simular que no hay conexión';
}

async function sincronizar({ silencioso = true } = {}) {
  // Se intenta aunque el último intento haya fallado: así se detecta que el servidor volvió.
  if (sincronizando || !navigator.onLine || simulado()) return;
  sincronizando = true;
  let enviados = 0;
  try {
    // 1. Recursos que un docente publicó sin conexión.
    for (const r of await db.todos('salida')) {
      const { recurso } = await api('/api/recursos', { method: 'POST', body: JSON.stringify(r) });
      await db.guardar('descargas', { ...recurso, guardado: new Date().toISOString() });
      await db.borrar('salida', r.id);
      enviados += 1;
    }
    // 2. Lecturas registradas localmente, en lotes pequeños (RNF04).
    const eventos = pendientesDeSincronizar(await db.todos('eventos'));
    for (const lote of lotes(eventos)) {
      const { confirmados } = await api('/api/sincronizar', { method: 'POST', body: JSON.stringify({ eventos: lote.map(compactarEvento) }) });
      const ok = new Set(confirmados);
      await db.guardarVarios('eventos', lote.filter((e) => ok.has(e.id)).map((e) => ({ ...e, sincronizado: true })));
      enviados += ok.size;
    }
    await actualizarCatalogo();
    if (enviados && !silencioso) avisar(`Sincronización completa: ${enviados} registro(s) enviados.`);
    else if (enviados) avisar('Tus datos se sincronizaron con el servidor.');
  } catch (err) {
    if (!(err instanceof SinConexion) && !silencioso) avisar('No se pudo sincronizar. Se intentará de nuevo.');
  } finally {
    sincronizando = false;
    await contarPendientes();
  }
}

async function actualizarCatalogo() {
  try {
    const { recursos } = await api('/api/recursos');
    await db.reemplazar('catalogo', recursos);
  } catch (err) {
    if (!(err instanceof SinConexion)) throw err;
  }
}

/** Catálogo visible: lo que llegó del servidor más lo que el docente publicó sin conexión. */
async function catalogo() {
  const [lista, salida, descargas] = await Promise.all([db.todos('catalogo'), db.todos('salida'), db.todos('descargas')]);
  const guardados = new Set(descargas.map((d) => d.id));
  const ids = new Set(lista.map((r) => r.id));
  const pendientesLocales = salida.filter((r) => !ids.has(r.id)).map((r) => ({ ...r, pendiente: true }));
  return [...lista, ...pendientesLocales].map((r) => ({ ...r, guardado: guardados.has(r.id) || r.pendiente }));
}

async function recursoCompleto(id) {
  const local = (await db.obtener('descargas', id)) || (await db.obtener('salida', id));
  if (local) return { recurso: local, guardado: true };
  try {
    const { recurso } = await api(`/api/recursos/${encodeURIComponent(id)}`);
    return { recurso, guardado: false };
  } catch (err) {
    if (err instanceof SinConexion) return { recurso: null, guardado: false };
    throw err;
  }
}

async function descargar(id) {
  try {
    const { recurso } = await api(`/api/recursos/${encodeURIComponent(id)}`);
    await db.guardar('descargas', { ...recurso, guardado: new Date().toISOString() });
    avisar(`«${recurso.titulo}» quedó guardado para usarlo sin internet.`);
  } catch (err) {
    avisar(err instanceof SinConexion ? 'Necesitas conexión para guardar este recurso.' : 'No se pudo guardar el recurso.');
  }
}

// ---------- registro de lecturas (RF04 / HU03) ----------
function iniciarLectura(recurso) {
  lecturaActual = { recurso, inicio: Date.now(), sinConexion: !enLinea() };
}

async function cerrarLectura() {
  if (!lecturaActual) return;
  const { recurso, inicio, sinConexion } = lecturaActual;
  lecturaActual = null;
  if (sesion?.rol !== 'estudiante') return;
  const evento = crearEventoLectura({ usuario: sesion, recurso, inicio, fin: Date.now(), sinConexion: sinConexion || !enLinea() });
  if (!evento) return;
  await db.guardar('eventos', evento);
  await contarPendientes();
  sincronizar();
}

// Si el estudiante cambia de aplicación, la lectura se pausa y se retoma al volver.
let lecturaPausada = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    const recurso = lecturaActual?.recurso;
    cerrarLectura();
    if (recurso) lecturaPausada = recurso;
  } else if (lecturaPausada && location.hash.startsWith('#/leer/')) {
    iniciarLectura(lecturaPausada);
    lecturaPausada = null;
  }
});

// ---------- vistas ----------
const MENUS = {
  estudiante: [['#/biblioteca', '📚', 'Biblioteca'], ['#/descargas', '📥', 'Sin conexión'], ['#/actividad', '📈', 'Mi actividad'], ['#/salir', '🚪', 'Salir']],
  docente: [['#/recursos', '📚', 'Recursos'], ['#/publicar', '➕', 'Publicar'], ['#/panel', '📊', 'Actividad'], ['#/salir', '🚪', 'Salir']],
};

function pintarMenu(ruta) {
  if (!sesion) { menu.hidden = true; return; }
  menu.hidden = false;
  menu.innerHTML = MENUS[sesion.rol].map(([href, icono, texto]) =>
    `<a href="${href}" ${ruta.startsWith(href) ? 'aria-current="page"' : ''}><span class="icono" aria-hidden="true">${icono}</span>${texto}</a>`).join('');
}

function tarjetaRecurso(r) {
  const estado = r.pendiente
    ? '<span class="etiqueta pend">Pendiente de publicar</span>'
    : r.guardado ? '<span class="etiqueta ok">✓ Disponible sin conexión</span>' : '';
  const propio = sesion.rol === 'estudiante' && r.grado === sesion.grado ? '<span class="etiqueta ok">Tu grado</span>' : '';
  const boton = r.guardado
    ? `<a class="boton" href="#/leer/${esc(r.id)}">Abrir</a>`
    : `<button class="boton" data-descargar="${esc(r.id)}" type="button">Guardar sin conexión</button>
       <a class="boton boton-claro" href="#/leer/${esc(r.id)}">Ver</a>`;
  return `<article class="tarjeta recurso">
    <div class="etiquetas"><span class="etiqueta">${esc(r.tipo || 'Guía')}</span><span class="etiqueta">Grado ${esc(r.grado)}</span>${propio}${estado}</div>
    <h3>${esc(r.titulo)}</h3>
    <p>${esc(r.descripcion || '')}</p>
    <div class="acciones">${boton}</div>
  </article>`;
}

function vistaIngreso() {
  let rol = 'estudiante';
  const formulario = () => `
    <div class="campo"><label for="nombre">Nombre</label><input id="nombre" required autocomplete="name" placeholder="Escribe tu nombre"></div>
    ${rol === 'estudiante'
      ? `<div class="campo"><label for="grado">Grado</label><select id="grado">${GRADOS.map((g) => `<option ${g === '9°' ? 'selected' : ''}>${g}</option>`).join('')}</select></div>`
      : `<div class="campo"><label for="area">Área que enseña</label><select id="area">${AREAS.map((a) => `<option>${a}</option>`).join('')}</select></div>`}`;
  vista.innerHTML = `
    <section class="ingreso tarjeta">
      <h1>Bienvenida y bienvenido</h1>
      <p>Guías y lecturas de la Institución Educativa 20 de Enero que puedes usar aunque no haya internet.</p>
      <div class="roles" role="group" aria-label="Tipo de usuario">
        <button class="rol" type="button" data-rol="estudiante" aria-pressed="true"><span class="icono" aria-hidden="true">🎒</span><strong>Estudiante</strong><small>Leer y estudiar</small></button>
        <button class="rol" type="button" data-rol="docente" aria-pressed="false"><span class="icono" aria-hidden="true">🧑‍🏫</span><strong>Docente</strong><small>Publicar y revisar</small></button>
      </div>
      <form id="form-ingreso"><div id="campos">${formulario()}</div>
        <button class="boton boton-grande" type="submit">Entrar</button>
        <p class="ayuda">Prototipo: el ingreso no usa contraseña. En la versión final se validará contra los usuarios de la institución.</p>
      </form>
    </section>`;
  vista.querySelectorAll('.rol').forEach((b) => b.addEventListener('click', () => {
    rol = b.dataset.rol;
    vista.querySelectorAll('.rol').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    vista.querySelector('#campos').innerHTML = formulario();
  }));
  vista.querySelector('#form-ingreso').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = vista.querySelector('#nombre').value.trim();
    if (nombre.length < 2) { avisar('Escribe tu nombre para continuar.'); return; }
    // Id aleatorio por dispositivo: el registro de uso no guarda documentos ni otros datos sensibles.
    sesion = rol === 'estudiante'
      ? { id: crearId('est'), nombre, rol, grado: vista.querySelector('#grado').value }
      : { id: crearId('doc'), nombre, rol, area: vista.querySelector('#area').value };
    escribirLocal(CLAVE_SESION, sesion);
    location.hash = rol === 'estudiante' ? '#/biblioteca' : '#/recursos';
  });
}

async function vistaBiblioteca({ titulo, subtitulo, soloGuardados = false }) {
  const filtro = vistaBiblioteca.filtro ?? { texto: '', area: '' };
  let recursos = await catalogo();
  if (soloGuardados) recursos = recursos.filter((r) => r.guardado);
  const sinRed = !enLinea();
  const pintar = () => {
    const t = filtro.texto.toLowerCase();
    const visibles = recursos.filter((r) => (!filtro.area || r.area === filtro.area)
      && (!t || `${r.titulo} ${r.descripcion}`.toLowerCase().includes(t)));
    vista.querySelector('#lista').innerHTML = visibles.length
      ? agruparPorArea(visibles).map((g) => `<h2 class="area-titulo">${esc(g.area)}</h2><div class="rejilla">${g.recursos.map(tarjetaRecurso).join('')}</div>`).join('')
      : `<div class="vacio">${soloGuardados
        ? 'Aún no has guardado recursos. Cuando tengas conexión, usa «Guardar sin conexión» en la biblioteca.'
        : recursos.length ? 'No hay recursos que coincidan con la búsqueda.' : 'No hay recursos todavía. Conéctate una vez para descargar el catálogo.'}</div>`;
  };
  vista.innerHTML = `
    <div class="encabezado"><div><h1>${titulo}</h1><p>${subtitulo}</p></div></div>
    ${sinRed && !soloGuardados ? '<div class="banda sin-red"><span>Estás sin conexión. Puedes abrir los recursos marcados como «Disponible sin conexión».</span></div>' : ''}
    <div class="filtros">
      <input id="buscar" type="search" placeholder="Buscar por título o tema" value="${esc(filtro.texto)}" aria-label="Buscar">
      <select id="filtro-area" aria-label="Área"><option value="">Todas las áreas</option>${AREAS.map((a) => `<option ${a === filtro.area ? 'selected' : ''}>${a}</option>`).join('')}</select>
    </div>
    <div id="lista"></div>`;
  pintar();
  vista.querySelector('#buscar').addEventListener('input', (e) => { filtro.texto = e.target.value; pintar(); });
  vista.querySelector('#filtro-area').addEventListener('change', (e) => { filtro.area = e.target.value; pintar(); });
  vistaBiblioteca.filtro = filtro;
  vista.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-descargar]')?.dataset.descargar;
    if (!id) return;
    e.target.disabled = true;
    await descargar(id);
    render();
  }, { once: false });
}

async function vistaDescargas() {
  const descargas = await db.todos('descargas');
  const kb = Math.max(0, Math.round(new TextEncoder().encode(JSON.stringify(descargas)).length / 1024));
  vista.innerHTML = `
    <div class="encabezado"><div><h1>Guardado en este dispositivo</h1><p>${descargas.length} recurso(s) · ${kb} KB usados</p></div></div>
    ${descargas.length ? `<div class="pila">${descargas.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')).map((r) => `
      <article class="tarjeta recurso">
        <div class="etiquetas"><span class="etiqueta">${esc(r.area)}</span><span class="etiqueta">Grado ${esc(r.grado)}</span><span class="etiqueta ok">Guardado ${esc(fecha(r.guardado))}</span></div>
        <h3>${esc(r.titulo)}</h3>
        <div class="acciones"><a class="boton" href="#/leer/${esc(r.id)}">Abrir</a><button class="boton boton-peligro" type="button" data-quitar="${esc(r.id)}">Quitar del dispositivo</button></div>
      </article>`).join('')}</div>`
      : '<div class="vacio">Aún no has guardado recursos. Cuando tengas conexión, ve a la biblioteca y usa «Guardar sin conexión».</div>'}`;
  vista.querySelectorAll('[data-quitar]').forEach((b) => b.addEventListener('click', async () => {
    await db.borrar('descargas', b.dataset.quitar);
    avisar('Recurso quitado del dispositivo.');
    render();
  }));
}

async function vistaLector(id) {
  const { recurso, guardado } = await recursoCompleto(id);
  if (!recurso) {
    vista.innerHTML = `<div class="vacio tarjeta"><h2>Este recurso no está guardado en tu dispositivo</h2>
      <p>Estás sin conexión y este recurso no se guardó antes. Cuando vuelvas a tener internet, ábrelo y usa «Guardar sin conexión».</p>
      <a class="boton" href="#/descargas">Ver lo que tengo guardado</a></div>`;
    return;
  }
  vista.innerHTML = `
    <section class="lector">
      <div class="meta">
        <a href="${sesion.rol === 'estudiante' ? '#/biblioteca' : '#/recursos'}" class="boton boton-claro">← Volver</a>
        <span class="cronometro" id="cronometro" aria-live="off"></span>
      </div>
      <div class="etiquetas"><span class="etiqueta">${esc(recurso.area)}</span><span class="etiqueta">Grado ${esc(recurso.grado)}</span>
        ${guardado ? '<span class="etiqueta ok">✓ Disponible sin conexión</span>' : ''}</div>
      <h1 style="margin-top:10px">${esc(recurso.titulo)}</h1>
      <p class="ayuda">${esc(recurso.docente || '')}</p>
      <article class="tarjeta">${parrafos(recurso.contenido).map((p) => `<p>${esc(p)}</p>`).join('')}</article>
      ${guardado ? '' : `<p style="margin-top:12px"><button class="boton" type="button" id="guardar-este">Guardar sin conexión</button></p>`}
    </section>`;
  vista.querySelector('#guardar-este')?.addEventListener('click', async () => { await descargar(recurso.id); render(); });
  iniciarLectura(recurso);
  const crono = vista.querySelector('#cronometro');
  const tic = () => {
    if (!lecturaActual || !crono.isConnected) return;
    const s = Math.round((Date.now() - lecturaActual.inicio) / 1000);
    crono.textContent = sesion.rol === 'estudiante' ? `Tiempo de lectura: ${formatearDuracion(s)}` : '';
    setTimeout(tic, 1000);
  };
  tic();
}

async function vistaMiActividad() {
  const eventos = (await db.todos('eventos')).filter((e) => e.usuarioId === sesion.id).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const r = resumenActividad(eventos);
  const sinSync = pendientesDeSincronizar(eventos).length;
  vista.innerHTML = `
    <div class="encabezado"><div><h1>Mi actividad</h1><p>${esc(sesion.nombre)} · Grado ${esc(sesion.grado)}</p></div></div>
    <div class="banda ${sinSync ? 'sin-red' : ''}">
      <span>${sinSync ? `${sinSync} lectura(s) guardadas en el dispositivo esperando conexión.` : 'Todas tus lecturas están sincronizadas.'}</span>
      <button class="boton boton-claro" type="button" id="sync" ${enLinea() ? '' : 'disabled'}>Sincronizar ahora</button>
    </div>
    <div class="cifras">
      <div class="tarjeta cifra"><span>${r.lecturas}</span><small>lecturas</small></div>
      <div class="tarjeta cifra"><span>${formatearDuracion(r.segundos)}</span><small>tiempo de estudio</small></div>
      <div class="tarjeta cifra"><span>${r.lecturasSinConexion}</span><small>lecturas sin conexión</small></div>
    </div>
    ${eventos.length ? `<div class="tarjeta tabla-scroll"><table>
      <thead><tr><th>Recurso</th><th>Fecha</th><th class="num">Tiempo</th><th>Estado</th></tr></thead>
      <tbody>${eventos.map((e) => `<tr><td>${esc(e.recursoTitulo)}</td><td>${esc(fecha(e.inicio))}</td><td class="num">${formatearDuracion(e.segundos)}</td>
        <td>${e.sincronizado ? '<span class="etiqueta ok">Sincronizada</span>' : '<span class="etiqueta pend">Pendiente</span>'}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="vacio">Cuando leas una guía, aquí verás el registro de tu actividad.</div>'}`;
  vista.querySelector('#sync').addEventListener('click', async () => { await sincronizar({ silencioso: false }); render(); });
}

function vistaPublicar() {
  vista.innerHTML = `
    <div class="encabezado"><div><h1>Publicar un recurso</h1><p>Si no hay conexión, el recurso se guarda y se publica solo cuando vuelva el internet.</p></div></div>
    <form id="form-recurso" class="tarjeta" novalidate>
      <div id="errores"></div>
      <div class="campo"><label for="titulo">Título</label><input id="titulo" maxlength="120" required></div>
      <div class="campos-2">
        <div class="campo"><label for="area">Área</label><select id="area">${AREAS.map((a) => `<option ${a === sesion.area ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div class="campo"><label for="grado">Grado</label><select id="grado">${GRADOS.map((g) => `<option>${g}</option>`).join('')}</select></div>
      </div>
      <div class="campos-2">
        <div class="campo"><label for="tipo">Tipo</label><select id="tipo"><option>Guía</option><option>Lectura</option><option>Taller</option></select></div>
        <div class="campo"><label for="descripcion">Descripción corta</label><input id="descripcion" maxlength="200"></div>
      </div>
      <div class="campo"><label for="contenido">Contenido</label><textarea id="contenido" required></textarea>
        <p class="ayuda">Deja una línea en blanco para separar los párrafos.</p></div>
      <button class="boton boton-grande" type="submit">Publicar</button>
    </form>`;
  vista.querySelector('#form-recurso').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => vista.querySelector(`#${id}`).value;
    const recurso = {
      id: crearId('rec'), titulo: v('titulo').trim(), area: v('area'), grado: v('grado'), tipo: v('tipo'),
      descripcion: v('descripcion').trim(), contenido: v('contenido'), docente: sesion.nombre,
    };
    const errores = validarRecurso(recurso);
    vista.querySelector('#errores').innerHTML = errores.length
      ? `<div class="errores"><ul>${errores.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    if (errores.length) return;
    await db.guardar('salida', recurso);
    await contarPendientes();
    if (enLinea()) {
      await sincronizar();
      avisar('Recurso publicado.');
    } else {
      avisar('Sin conexión: el recurso se publicará cuando vuelva el internet.');
    }
    location.hash = '#/recursos';
  });
}

async function vistaPanel() {
  let resumen = null;
  let origen = 'servidor';
  try {
    resumen = await api('/api/actividad');
    escribirLocal(CLAVE_PANEL, { resumen, fecha: new Date().toISOString() });
  } catch (err) {
    if (!(err instanceof SinConexion)) throw err;
    const ultimo = leerLocal(CLAVE_PANEL);
    if (ultimo) { resumen = ultimo.resumen; origen = `copia guardada el ${fecha(ultimo.fecha)}`; }
  }
  vista.innerHTML = `
    <div class="encabezado"><div><h1>Actividad de los estudiantes</h1>
      <p>${resumen ? `Datos sincronizados (${esc(origen)})` : 'Conéctate para ver la actividad consolidada.'}</p></div>
      <button class="boton boton-claro" type="button" id="actualizar">Actualizar</button></div>
    ${resumen ? `
    <div class="cifras">
      <div class="tarjeta cifra"><span>${resumen.estudiantes}</span><small>estudiantes activos</small></div>
      <div class="tarjeta cifra"><span>${resumen.lecturas}</span><small>lecturas</small></div>
      <div class="tarjeta cifra"><span>${formatearDuracion(resumen.segundos)}</span><small>tiempo total</small></div>
      <div class="tarjeta cifra"><span>${resumen.lecturas ? Math.round((resumen.lecturasSinConexion / resumen.lecturas) * 100) : 0}%</span><small>lecturas sin conexión</small></div>
    </div>
    ${resumen.recursos.length ? `<div class="tarjeta tabla-scroll"><table>
      <thead><tr><th>Recurso</th><th>Área</th><th class="num">Lecturas</th><th class="num">Tiempo</th></tr></thead>
      <tbody>${resumen.recursos.map((r) => `<tr><td>${esc(r.titulo)}</td><td>${esc(r.area)}</td><td class="num">${r.lecturas}</td><td class="num">${formatearDuracion(r.segundos)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="vacio">Todavía no hay lecturas sincronizadas.</div>'}` : '<div class="vacio">Sin datos todavía.</div>'}`;
  vista.querySelector('#actualizar').addEventListener('click', () => render());
}

// ---------- enrutador ----------
async function render() {
  const ruta = location.hash || '#/';
  await cerrarLectura();
  if (!sesion) {
    pintarMenu('');
    return vistaIngreso();
  }
  pintarMenu(ruta);
  const inicio = sesion.rol === 'estudiante' ? '#/biblioteca' : '#/recursos';
  if (ruta === '#/' || ruta === '#/ingresar') { location.replace(inicio); return; }
  if (ruta === '#/salir') {
    escribirLocal(CLAVE_SESION, null);
    sesion = null;
    location.replace('#/');
    return;
  }
  // Cada render reemplaza el contenedor de la vista para descartar los manejadores de la vista anterior.
  const nueva = vista.cloneNode(false);
  vista.replaceWith(nueva);
  vista = nueva;
  try {
    if (ruta.startsWith('#/leer/')) return await vistaLector(decodeURIComponent(ruta.slice(7)));
    if (sesion.rol === 'estudiante') {
      if (ruta === '#/descargas') return await vistaDescargas();
      if (ruta === '#/actividad') return await vistaMiActividad();
      return await vistaBiblioteca({ titulo: 'Biblioteca', subtitulo: `Hola, ${esc(sesion.nombre)}. Guarda las guías para leerlas sin internet.` });
    }
    if (ruta === '#/publicar') return vistaPublicar();
    if (ruta === '#/panel') return await vistaPanel();
    return await vistaBiblioteca({ titulo: 'Recursos publicados', subtitulo: `Docente ${esc(sesion.nombre)} · ${esc(sesion.area)}` });
  } catch (err) {
    console.error(err);
    vista.innerHTML = '<div class="vacio">Ocurrió un error al cargar esta sección.</div>';
  }
}

// ---------- arranque ----------
botonRed.addEventListener('click', async () => {
  escribirLocal(CLAVE_SIMULADO, simulado() ? null : true);
  pintarEstado();
  avisar(simulado() ? 'Modo sin conexión simulado activado.' : 'Conexión restablecida.');
  if (enLinea()) await sincronizar({ silencioso: false });
  render();
});
window.addEventListener('online', async () => { pintarEstado(); await sincronizar({ silencioso: false }); render(); });
window.addEventListener('offline', () => { pintarEstado(); render(); });
window.addEventListener('hashchange', render);
window.addEventListener('pagehide', () => { cerrarLectura(); });

let solicitudInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  solicitudInstalar = e;
  botonInstalar.hidden = false;
});
botonInstalar.addEventListener('click', async () => {
  botonInstalar.hidden = true;
  await solicitudInstalar?.prompt();
  solicitudInstalar = null;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('No se pudo registrar el service worker', err));
}

pintarEstado();
await contarPendientes();
await render();
sincronizar();
setInterval(() => sincronizar(), 30000);
