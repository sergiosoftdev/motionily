# Motionily — plan

## Producto

El cliente **no anima**. Elige piezas y escribe un brief; el agente monta el vídeo.
La experiencia es la de un **Lego**: piezas con forma conocida que encajan entre sí,
cajas (kits) que traen un conjunto ya pensado, y la libertad de cambiar cualquier
pieza por otra que encaje.

## El modelo Lego

### Pieza (`Brick`)
La unidad de todo el catálogo. Cada pieza ocupa una **ranura** (`slot`) del proyecto.

```ts
Brick {
  key: "palette/sunset"          // slot/nombre, estable y legible para el agente
  slot: BrickSlot
  name, description, tags[]
  fits: MotionStyleKey[]          // "studs": con qué estilos encaja (vacío = con todos)
  payload: {...}                  // datos propios del slot (colores, keyframes, glTF…)
  params: ParamSpec[]             // ajustes que el agente puede tocar (velocidad, intensidad…)
  engine: Supported | Planned     // si el motor ya sabe renderizarla
  visibility: Official | Private  // Private = creada por el agente para un proyecto
  version
}
```

### Ranuras (`BrickSlot`)
| Ranura | Ejemplos | Cardinalidad |
| --- | --- | --- |
| `motion_style` (la caja) | Apple, Startup, Isométrico, Anime, Cartoon, Paper cut | 1 |
| `palette` | Sunset, Midnight, Clinic green, Pastel pop | 1 |
| `composition` | Asimétrico, Centrado, Split, Hueco | 1 |
| `typography` | Inter titular, Display redondeada, Manuscrita | 1 |
| `render_style` | Flat, Toon con contorno, Papel recortado, Clay | 1 |
| `scenario` | Consulta 3D, Oficina, Ciudad, Estudio vacío | 0..1 |
| `character` | Monigote liso, Monigote con ropa, Blob | 0..n |
| `animation` | Pop in, Slide up, Squash, Whip pan | 0..n |
| `transition` | Shape wipe, Zoom through, Morph | 0..n |
| `captions` | Minimal, Karaoke, Pop palabra, Highlight | 1 |

### Caja (`motion_style`)
Un estilo de motion es una pieza especial: trae **piezas por defecto** para las
demás ranuras. Elegir "Apple" rellena paleta, tipografía, render, composición y
animaciones de golpe; luego el cliente cambia lo que quiera. Las piezas que no
encajan (`fits`) con la caja elegida se muestran apagadas, no prohibidas.

### Montaje (`Build`)
El proyecto guarda qué pieza ocupa cada ranura:
```ts
Build { motion_style, palette, composition, typography, render_style, captions,
        scenario?, characters[], animations[], transitions[] }
```

### El agente
- Lee el `Build` y el brief, monta la escena **referenciando piezas**
  (`{"use":"animation/pop-in","target":"title"}`), no escribiendo keyframes.
- Si una animación no existe, la crea y la guarda como pieza `Private` del
  proyecto. Nosotros podemos promocionarla a `Official`.
- Nunca cambia una pieza elegida por el cliente; puede sugerir.

### Ampliar la librería
Una pieza nueva = un documento en `bricks` (seed versionado en el repo). Sin
desplegar código, salvo que necesite una capacidad nueva del motor
(`engine: Planned` hasta entonces).

## Arquitectura

```
apps/web (React)  ──REST──▶  apps/api (NestJS + Mongo)  ◀──REST──  packages/mcp-server
     │                            users · projects · bricks · feedback          ▲
     ▼                                                                          │
engine WASM (Rust/wgpu)  ◀────── WebSocket (ops en vivo) ───────────────────────┘
```
- La API es la fuente de verdad persistente (proyectos, escena, build, feedback, versiones).
- El editor sigue siendo quien valida y renderiza en vivo con el motor Rust.
- Auth: login de Google **simulado** (JWT propio). Google OAuth real después, sin tocar el resto.

## Fases

1. ✅ **API base** — NestJS + Mongo: auth simulada, usuarios, proyectos, catálogo de
   piezas con seed (cajas Apple, Startup, Isométrico, Anime, Cartoon, Paper cut y
   sus piezas). Tests e2e con Mongo en memoria.
2. ✅ **Editor con cuenta** — login simulado, lista de proyectos, crear proyecto
   eligiendo caja, montaje Lego (ranuras + piezas), guardado en la API.
3. ✅ **Agente sobre la API** — MCP con token y proyecto: `get_build`, `list_bricks`,
   `apply_ops`, `create_brick`, `get_feedback`; feedback persistido.
4. ✅ **Piezas en el motor** — ops que referencian piezas (`use`), animaciones
   paramétricas, composición, paletas reales por pieza.
5b. ✅ **Timeline y selección** — línea de tiempo abajo tipo CapCut (audio con onda y
   recorte, subtítulos palabra a palabra, capas); clic en un objeto del vídeo para
   seleccionarlo y comentar sobre él: el agente recibe la referencia y lee solo esa
   capa (`get_layer`), sin cargar el proyecto entero.
5. ✅ **Texto y subtítulos** — cosmic-text + atlas, estilos de captions.
6. **Render styles** — shaders toon/contorno, papel recortado, clay sobre 2D.
7. **3D** — glTF, escenarios y personajes con esqueleto, isométrico.
8. **Producto** — Google OAuth real, export MP4, Tauri, pagos.
