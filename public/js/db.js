// Persistencia local con IndexedDB (RNF01). Todo lo que la app necesita sin conexión vive aquí.
const NOMBRE = 'aula-20-de-enero';
const VERSION = 1;

// catalogo: lista de recursos (sin contenido) · descargas: recursos completos guardados en el dispositivo
// eventos: registro local de lecturas (RF04) · salida: recursos publicados por un docente sin conexión
export const ALMACENES = ['catalogo', 'descargas', 'eventos', 'salida'];

let conexion;

function abrir() {
  if (conexion) return conexion;
  conexion = new Promise((ok, falla) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = () => {
      for (const nombre of ALMACENES) {
        if (!req.result.objectStoreNames.contains(nombre)) req.result.createObjectStore(nombre, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => falla(req.error);
  });
  return conexion;
}

async function operar(almacen, modo, accion) {
  const db = await abrir();
  return new Promise((ok, falla) => {
    const tx = db.transaction(almacen, modo);
    const resultado = accion(tx.objectStore(almacen));
    tx.oncomplete = () => ok(resultado?.result);
    tx.onerror = () => falla(tx.error);
    tx.onabort = () => falla(tx.error);
  });
}

export const todos = (almacen) => operar(almacen, 'readonly', (s) => s.getAll());
export const obtener = (almacen, id) => operar(almacen, 'readonly', (s) => s.get(id));
export const guardar = (almacen, item) => operar(almacen, 'readwrite', (s) => s.put(item));
export const borrar = (almacen, id) => operar(almacen, 'readwrite', (s) => s.delete(id));

export function guardarVarios(almacen, items) {
  return operar(almacen, 'readwrite', (s) => { for (const it of items) s.put(it); });
}

/** Reemplaza todo el contenido de un almacén en una sola transacción. */
export function reemplazar(almacen, items) {
  return operar(almacen, 'readwrite', (s) => {
    s.clear();
    for (const it of items) s.put(it);
  });
}
