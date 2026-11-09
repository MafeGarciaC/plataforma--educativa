# Aula 20 de Enero — prototipo PWA offline-first

Prototipo de la plataforma web progresiva (PWA) con arquitectura offline-first propuesta en el trabajo de grado
*Plataforma web progresiva con arquitectura offline-first para mejorar el acceso a contenidos educativos en la
Institución Educativa 20 de Enero de Sincelejo, Sucre* (Ingeniería de Sistemas, CECAR).

Autoras: Daniela Díaz Caro, María Fernanda García Conde y Estefanía Villalba Paternina.

## Qué hace

| Requerimiento / HU | Cómo lo cubre el prototipo |
| --- | --- |
| RF01 · Autenticación y roles | Ingreso como **estudiante** (con grado) o **docente** (con área). En el prototipo no hay contraseña. |
| RF02 · Recursos por área (HU02) | Biblioteca agrupada por área con búsqueda y filtro. El docente publica guías, lecturas y talleres. |
| RF03 · Lectura sin conexión (HU01) | «Guardar sin conexión» descarga el recurso completo a IndexedDB; se puede abrir sin internet. |
| RF04 · Registro local de uso (HU03) | Cada lectura de un estudiante (recurso, fecha, segundos, si fue sin conexión) se guarda en el dispositivo. El registro es anónimo: lleva un código aleatorio y el grado, nunca el nombre (Ley 1581 de 2012). |
| RF05 · Sincronización (HU04) | Al volver la conexión (y cada 30 s) se envían las lecturas pendientes y los recursos publicados sin conexión. |
| RNF01 · PWA offline-first | Service Worker con caché de la aplicación, IndexedDB y manifiesto instalable. |
| RNF02 · Diseño adaptativo | Interfaz pensada primero para celular; funciona en tabletas y computadores. |
| RNF04 · Bajo consumo de datos | El catálogo viaja sin contenido; cada recurso se descarga solo cuando se pide; la sincronización va en lotes de 25. |

Para el piloto con el grado 9° y el área de Lengua Castellana, la plataforma trae cuatro guías de ejemplo de esa área
(texto argumentativo, crónica, figuras literarias e inferencias); el docente puede publicar las guías definitivas
desde la sección **Publicar**.

El panel del docente muestra estudiantes activos, número de lecturas, tiempo total, porcentaje de lecturas hechas sin
conexión y los recursos más consultados: son los datos que se usarán en la evaluación (objetivo específico 4).

## Cómo ejecutarlo

Requisitos: [Node.js](https://nodejs.org) 20 o superior. No hay dependencias que instalar.

```bash
npm start
```

Abrir <http://localhost:3000>. Para probarlo desde un celular en la misma red wifi se usa la IP del computador
(por ejemplo `http://192.168.1.10:3000`); ten en cuenta que los navegadores solo activan el Service Worker en
`localhost` o con HTTPS.

### Probar el modo sin conexión

1. Entrar como estudiante y usar **Guardar sin conexión** en una o varias guías.
2. Tocar la pastilla **En línea** del encabezado para simular que no hay internet (o apagar el servidor / activar
   «Offline» en las herramientas de desarrollador del navegador).
3. Abrir una guía guardada y leerla unos segundos: la lectura queda en **Mi actividad** como «Pendiente».
4. Volver a tocar la pastilla (o encender el servidor): las lecturas pasan a «Sincronizada» y aparecen en el panel
   **Actividad** del docente.

## Pruebas

```bash
npm test
```

Incluye pruebas unitarias de la lógica (`test/logic.test.js`) y pruebas de integración de la API con un servidor
real y una base de datos temporal (`test/api.test.js`), entre ellas que reenviar un lote de sincronización no duplica
lecturas.

## Estructura

```
server.js                 Servidor sin dependencias: archivos de la PWA + API
data/recursos-iniciales.json  Guías de ejemplo (se copian a data/db.json la primera vez)
public/
  index.html, css/app.css
  manifest.webmanifest, icons/
  sw.js                   Service Worker (caché de la app y respaldo de la API)
  js/app.js               Interfaz, enrutador y sincronización
  js/db.js                Acceso a IndexedDB
  js/logic.js             Lógica pura compartida por la app, el servidor y las pruebas
test/                     Pruebas con node:test
```

### API

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/recursos` | Catálogo sin contenido |
| GET | `/api/recursos/:id` | Recurso completo para guardarlo sin conexión |
| POST | `/api/recursos` | Publicar un recurso (idempotente por `id`) |
| POST | `/api/sincronizar` | Enviar lecturas `{ eventos: [...] }` (idempotente por `id`) |
| GET | `/api/actividad` | Resumen de uso para el panel del docente |

## Al modificar la app

Cada vez que cambie un archivo de `public/`, sube la constante `VERSION` de `public/sw.js` (por ejemplo `aula-v4`)
para que los dispositivos que ya tienen la app descarguen la versión nueva.

## Limitaciones del prototipo

- El ingreso no valida usuarios; la versión final debe conectarse con los usuarios de la institución.
- Los datos del servidor se guardan en un archivo JSON (`data/db.json`); para el piloto se recomienda una base de
  datos como PostgreSQL o SQLite.
- Los recursos son de texto; falta permitir adjuntar PDF e imágenes.
- Los recursos guardados se comparten entre las personas que usan el mismo dispositivo.
