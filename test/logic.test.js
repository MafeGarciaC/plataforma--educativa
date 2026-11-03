import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crearEventoLectura, pendientesDeSincronizar, lotes, compactarEvento, unirEventos,
  resumenActividad, formatearDuracion, agruparPorArea, validarRecurso, parrafos,
} from '../public/js/logic.js';

const usuario = { id: 'est-1', nombre: 'Ana', grado: '7°' };
const recurso = { id: 'rec-1', titulo: 'El ciclo del agua', area: 'Ciencias Naturales' };

test('crearEventoLectura registra la duración en segundos', () => {
  const e = crearEventoLectura({ usuario, recurso, inicio: 0, fin: 95_000, sinConexion: true });
  assert.equal(e.segundos, 95);
  assert.equal(e.recursoId, 'rec-1');
  assert.equal(e.sinConexion, true);
  assert.equal(e.sincronizado, false);
});

test('crearEventoLectura descarta aperturas accidentales', () => {
  assert.equal(crearEventoLectura({ usuario, recurso, inicio: 0, fin: 1500 }), null);
});

test('pendientesDeSincronizar solo devuelve lo no enviado', () => {
  const eventos = [{ id: 'a', sincronizado: true }, { id: 'b', sincronizado: false }];
  assert.deepEqual(pendientesDeSincronizar(eventos).map((e) => e.id), ['b']);
});

test('lotes divide la lista sin perder elementos', () => {
  const r = lotes([1, 2, 3, 4, 5], 2);
  assert.deepEqual(r, [[1, 2], [3, 4], [5]]);
});

test('compactarEvento no envía el estado local de sincronización', () => {
  assert.deepEqual(compactarEvento({ id: 'a', segundos: 4, sincronizado: false }), { id: 'a', segundos: 4 });
});

test('unirEventos ignora eventos repetidos o inválidos', () => {
  const { todos, agregados } = unirEventos([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }, { id: 'b' }, null, { id: 3 }]);
  assert.deepEqual(todos.map((e) => e.id), ['a', 'b']);
  assert.equal(agregados.length, 1);
});

test('resumenActividad agrupa por recurso y cuenta estudiantes', () => {
  const ev = (usuarioId, recursoId, segundos, sinConexion = false) => ({ usuarioId, recursoId, recursoTitulo: recursoId, area: 'X', segundos, sinConexion });
  const r = resumenActividad([ev('u1', 'r1', 60, true), ev('u2', 'r1', 30), ev('u1', 'r2', 120)]);
  assert.equal(r.lecturas, 3);
  assert.equal(r.segundos, 210);
  assert.equal(r.estudiantes, 2);
  assert.equal(r.lecturasSinConexion, 1);
  assert.equal(r.recursos[0].recursoId, 'r1');
  assert.equal(r.recursos[0].lecturas, 2);
});

test('formatearDuracion', () => {
  assert.equal(formatearDuracion(45), '45 s');
  assert.equal(formatearDuracion(120), '2 min');
  assert.equal(formatearDuracion(200), '3 min 20 s');
  assert.equal(formatearDuracion(3720), '1 h 2 min');
});

test('agruparPorArea respeta el orden de las áreas y ordena por título', () => {
  const g = agruparPorArea([
    { titulo: 'B', area: 'Inglés' }, { titulo: 'Z', area: 'Matemáticas' }, { titulo: 'A', area: 'Matemáticas' },
  ]);
  assert.deepEqual(g.map((x) => x.area), ['Matemáticas', 'Inglés']);
  assert.deepEqual(g[0].recursos.map((r) => r.titulo), ['A', 'Z']);
});

test('validarRecurso exige título, área, grado y contenido', () => {
  assert.equal(validarRecurso({ titulo: 'Guía de fracciones', area: 'Matemáticas', grado: '6°', contenido: 'x'.repeat(30) }).length, 0);
  assert.equal(validarRecurso({ titulo: 'ab', area: 'Música', contenido: '' }).length, 4);
});

test('parrafos separa por líneas en blanco', () => {
  assert.deepEqual(parrafos('Uno\nsigue\n\n  Dos  \n\n\n'), ['Uno sigue', 'Dos']);
});
