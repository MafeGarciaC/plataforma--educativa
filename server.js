// Servidor del prototipo: sirve la PWA y una API mínima de recursos y sincronización.
// No usa dependencias externas; los datos se guardan en data/db.json.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validarRecurso, unirEventos, resumenActividad, crearId, tamanoKB } from './public/js/logic.js';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(RAIZ, 'public');
const LIMITE_CUERPO = 512 * 1024;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export async function crearBaseDeDatos(ruta) {
  async function cargar() {
    if (existsSync(ruta)) return JSON.parse(await readFile(ruta, 'utf8'));
    const recursos = JSON.parse(await readFile(join(RAIZ, 'data', 'recursos-iniciales.json'), 'utf8'))
      .map((r) => ({ ...r, publicado: '2026-11-01T12:00:00.000Z' }));
    return { recursos, eventos: [] };
  }
  let datos = await cargar();
  // Las escrituras se encadenan para que dos peticiones simultáneas no se pisen.
  let cola = Promise.resolve();
  const guardar = () => {
    cola = cola.then(async () => {
      await mkdir(dirname(ruta), { recursive: true });
      await writeFile(ruta, JSON.stringify(datos, null, 2));
    });
    return cola;
  };
  return { get datos() { return datos; }, guardar };
}

function enviarJSON(res, estado, cuerpo) {
  res.writeHead(estado, { 'Content-Type': TIPOS['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}

async function leerJSON(req) {
  let tam = 0;
  const partes = [];
  for await (const parte of req) {
    tam += parte.length;
    if (tam > LIMITE_CUERPO) throw Object.assign(new Error('Cuerpo demasiado grande'), { estado: 413 });
    partes.push(parte);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON inválido'), { estado: 400 });
  }
}

async function api(req, res, db, ruta) {
  if (req.method === 'GET' && ruta === '/api/recursos') {
    // El catálogo viaja sin el contenido para gastar pocos datos; el contenido se descarga por recurso (RNF04).
    const recursos = db.datos.recursos.map(({ contenido, ...meta }) => ({ ...meta, tamanoKB: tamanoKB({ contenido }) }));
    return enviarJSON(res, 200, { recursos });
  }
  const unRecurso = ruta.match(/^\/api\/recursos\/([\w-]+)$/);
  if (req.method === 'GET' && unRecurso) {
    const recurso = db.datos.recursos.find((r) => r.id === unRecurso[1]);
    return recurso ? enviarJSON(res, 200, { recurso }) : enviarJSON(res, 404, { error: 'Recurso no encontrado' });
  }
  if (req.method === 'POST' && ruta === '/api/recursos') {
    const r = await leerJSON(req);
    const errores = validarRecurso(r);
    if (errores.length) return enviarJSON(res, 422, { errores });
    // Un recurso creado sin conexión ya trae su id; si se reenvía, no se duplica.
    const existente = db.datos.recursos.find((x) => x.id === r.id);
    if (existente) return enviarJSON(res, 200, { recurso: existente });
    const recurso = {
      id: typeof r.id === 'string' ? r.id : crearId('rec'),
      titulo: r.titulo.trim(),
      area: r.area,
      grado: r.grado,
      tipo: r.tipo || 'Guía',
      docente: r.docente || 'Docente',
      descripcion: (r.descripcion || '').trim(),
      contenido: r.contenido.trim(),
      publicado: new Date().toISOString(),
    };
    db.datos.recursos.push(recurso);
    await db.guardar();
    return enviarJSON(res, 201, { recurso });
  }
  if (req.method === 'POST' && ruta === '/api/sincronizar') {
    const { eventos } = await leerJSON(req);
    if (!Array.isArray(eventos)) return enviarJSON(res, 400, { error: 'Se esperaba una lista de eventos.' });
    const { todos, agregados } = unirEventos(db.datos.eventos, eventos);
    db.datos.eventos = todos;
    if (agregados.length) await db.guardar();
    // Se confirman todos los ids recibidos (también los repetidos) para que el cliente los marque como sincronizados.
    return enviarJSON(res, 200, { confirmados: eventos.map((e) => e?.id).filter(Boolean), nuevos: agregados.length });
  }
  if (req.method === 'GET' && ruta === '/api/actividad') {
    return enviarJSON(res, 200, resumenActividad(db.datos.eventos));
  }
  return enviarJSON(res, 404, { error: 'Ruta no encontrada' });
}

async function estatico(req, res, ruta) {
  const archivo = normalize(join(PUBLICO, ruta === '/' ? 'index.html' : decodeURIComponent(ruta)));
  if (!archivo.startsWith(PUBLICO)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const contenido = await readFile(archivo);
    const cabeceras = { 'Content-Type': TIPOS[extname(archivo)] || 'application/octet-stream' };
    // El service worker debe revisarse siempre para que las actualizaciones lleguen.
    if (archivo.endsWith('sw.js')) cabeceras['Cache-Control'] = 'no-cache';
    res.writeHead(200, cabeceras);
    res.end(contenido);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

export async function iniciarServidor({ puerto = 3000, rutaDatos = join(RAIZ, 'data', 'db.json') } = {}) {
  const db = await crearBaseDeDatos(rutaDatos);
  const servidor = createServer(async (req, res) => {
    const ruta = new URL(req.url, 'http://localhost').pathname;
    try {
      if (ruta.startsWith('/api/')) return await api(req, res, db, ruta);
      if (req.method !== 'GET' && req.method !== 'HEAD') return enviarJSON(res, 405, { error: 'Método no permitido' });
      return await estatico(req, res, ruta);
    } catch (err) {
      enviarJSON(res, err.estado || 500, { error: err.estado ? err.message : 'Error interno' });
    }
  });
  await new Promise((ok) => servidor.listen(puerto, ok));
  return servidor;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const puerto = Number(process.env.PORT) || 3000;
  await iniciarServidor({ puerto });
  console.log(`Aula 20 de Enero disponible en http://localhost:${puerto}`);
}
