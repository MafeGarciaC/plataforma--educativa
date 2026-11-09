// Pruebas de integración de la API: levantan el servidor real con una base de datos temporal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iniciarServidor } from '../server.js';

let servidor;
let base;
let carpeta;

before(async () => {
  carpeta = await mkdtemp(join(tmpdir(), 'aula-'));
  servidor = await iniciarServidor({ puerto: 0, rutaDatos: join(carpeta, 'db.json') });
  base = `http://localhost:${servidor.address().port}`;
});

after(async () => {
  servidor.close();
  await rm(carpeta, { recursive: true, force: true });
});

const post = (ruta, cuerpo) => fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

test('el catálogo se envía sin el contenido de los recursos', async () => {
  const { recursos } = await (await fetch(`${base}/api/recursos`)).json();
  assert.ok(recursos.length >= 6);
  assert.ok(recursos.every((r) => r.contenido === undefined && r.tamanoKB >= 1));
});

test('un recurso se puede descargar completo', async () => {
  const resp = await fetch(`${base}/api/recursos/rec-ciclo-agua`);
  assert.equal(resp.status, 200);
  const { recurso } = await resp.json();
  assert.match(recurso.contenido, /evaporación/i);
});

test('publicar valida los datos y no duplica un recurso reenviado', async () => {
  const malo = await post('/api/recursos', { titulo: 'x' });
  assert.equal(malo.status, 422);

  const nuevo = { id: 'rec-prueba', titulo: 'Taller de prueba', area: 'Tecnología', grado: '8°', contenido: 'Contenido de prueba suficientemente largo.' };
  assert.equal((await post('/api/recursos', nuevo)).status, 201);
  assert.equal((await post('/api/recursos', nuevo)).status, 200);
  const { recursos } = await (await fetch(`${base}/api/recursos`)).json();
  assert.equal(recursos.filter((r) => r.id === 'rec-prueba').length, 1);
});

test('sincronizar es idempotente: reenviar un lote no duplica lecturas', async () => {
  const eventos = [
    { id: 'ev-1', usuarioId: 'est-1', recursoId: 'rec-ciclo-agua', recursoTitulo: 'El ciclo del agua', area: 'Ciencias Naturales', segundos: 120, sinConexion: true },
    { id: 'ev-2', usuarioId: 'est-2', recursoId: 'rec-ciclo-agua', recursoTitulo: 'El ciclo del agua', area: 'Ciencias Naturales', segundos: 60, sinConexion: false },
  ];
  const r1 = await (await post('/api/sincronizar', { eventos })).json();
  assert.deepEqual(r1.confirmados, ['ev-1', 'ev-2']);
  assert.equal(r1.nuevos, 2);
  const r2 = await (await post('/api/sincronizar', { eventos })).json();
  assert.equal(r2.nuevos, 0);

  // Un cliente viejo que envíe el nombre no lo deja guardado en el servidor.
  await post('/api/sincronizar', { eventos: [{ ...eventos[0], id: 'ev-3', usuarioNombre: 'Ana' }] });
  const resumen = await (await fetch(`${base}/api/actividad`)).json();
  assert.equal(resumen.lecturas, 3);
  assert.equal(resumen.estudiantes, 2);
  assert.equal(resumen.lecturasSinConexion, 2);
  const guardado = JSON.parse(await readFile(join(carpeta, 'db.json'), 'utf8'));
  assert.equal(JSON.stringify(guardado.eventos).includes('usuarioNombre'), false);
});

test('rechaza cuerpos inválidos y rutas fuera de la carpeta pública', async () => {
  assert.equal((await post('/api/sincronizar', { eventos: 'no' })).status, 400);
  const resp = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(resp.status, 200);
});
