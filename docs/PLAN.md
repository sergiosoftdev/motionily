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
   capa (`inspect ID`), sin cargar el proyecto entero.
5. ✅ **Texto y subtítulos** — cosmic-text + atlas, estilos de captions.
6. ✅ **Render styles** — shaders toon/contorno, papel recortado, clay sobre 2D.
7. ✅ **3D (2.5D procedural)** — glTF, escenarios y personajes con esqueleto, isométrico.
8. **Producto** — Google OAuth real (para la versión servidor); ✅ export MP4 y app Tauri (ver abajo). Sin pagos: todo open source.

## Hecho: autorrevisión visual del agente (pedido y hecho 2026-10-19)
El MCP debe poder revisar el vídeo solo, sin humano: Playwright headless abre el editor, renderiza
fotogramas/tiras (contact sheet) y clips cortos, y se los devuelve a Claude como imágenes para detectar
fallos visibles (texto cortado o solapado, personajes fuera de plano, animaciones que no se mueven,
saltos, colisiones, cámara mal encuadrada) y corregirlos en bucle hasta que quede bien.
- Tool `review_video`: contact sheet por plano + checks automáticos (bounds de texto, props fuera de cámara, frames idénticos).
- Funciona aunque no haya editor abierto (navegador headless propio en la API).
- Bucle en GenerateService: generar, revisar, corregir (máx N rondas).
- v1 hecha: `review_video` (hoja de contactos + checks: fuera de encuadre, texto solapado, tramos muertos,
  fotogramas vacíos), editor headless con Playwright cuando no hay editor abierto (token scope `editor`),
  bucle de revisión en la guía de Generar. Pendiente: checks 3D (personajes fuera de plano/cortados), clips cortos.

## Editor profesional de escritorio, open source (planteado 2026-10-23; fase 1 hecha 2026-10-24)
Motionily como editor completo y "agent-first": edición, motion graphics, color y todo lo que use un
profesional, con estética CapCut. El MCP es una capa más: el agente puede hacer todo lo que hace el humano.

**Principio fijo:** cada acción de la UI es una op del protocolo y una tool del MCP. No perseguir igualar
CapCut/DaVinci en funciones: el 80/20 del short-form y, sobre todo, lo que el agente hace por ti (primer
montaje por transcripción, quitar silencios y muletillas, subtítulos, reencuadre, igualar color entre clips,
material de búsquedas, versiones por plataforma, títulos y hashtags).

**Todo open source (decisión 2026-10-24).** Licencia MIT, sin funciones de pago ni comprobación de licencia en
el código. Cada uno lo usa con su herramienta: cualquier cliente MCP desde fuera (Connect your agent) y, dentro de
la app, el CLI que elija (Claude Code, Codex, Gemini CLI u OpenCode; `apps/api/src/common/agent-cli.ts`).
Sustituye al modelo "gratis + funciones de pago" y al open core del 2026-10-23.

**Todo en el PC del usuario.** Nada de footage en servidor.
- App de escritorio con **Tauri 2** (`apps/desktop`): arranca la API en local (Node empaquetado, SQLite en la
  carpeta de datos de la app, puerto estable 47310 en 127.0.0.1), cuenta local sin contraseña.
- Motor wgpu **nativo**: export en GPU hasta 4K (H.264, HEVC 10 bits, ProRes 422 HQ) con ffmpeg; visor nativo
  sobre Metal mientras se reproduce (una vista que deja pasar los clics encima del canvas; en pausa vuelve el
  canvas WebGPU con sus gizmos). Windows/Linux: canvas WebGPU del webview de momento.
- ffmpeg decodifica los clips (`-hwaccel auto`) y codifica.
- SQLite sin Mongo: un driver de Mongoose sobre `node:sqlite` + mingo (`DATABASE_URL=sqlite:…`); los servicios no
  cambian y la suite e2e pasa en las dos bases.
- Proyecto como carpeta: Archivo › Save Video as Folder… / Open Project Folder… (`<nombre>.motionily/` con
  `project.json` y `media/`).
- El MCP stdio sigue igual: el agente y la app en la misma máquina.
- Builds por SO en GitHub Actions (`.github/workflows/desktop.yml`); falta firma (Apple Developer + notarización,
  certificado de Windows).

**Fases**
1. ✅ Base de escritorio: Tauri, motor nativo (export + visor macOS), ffmpeg, proyecto en carpeta, SQLite, agente a
   elegir, open source (README, CONTRIBUTING, docs/agents.md, THIRD_PARTY.md, CI).
2. Editor sólido (pedido por Sergio el 2026-10-24, rollo DaVinci Resolve con estética CapCut):
   - **Panel de medios** único (Media Pool): vídeos, audio (mp3, wav…), imágenes; miniaturas, duración, arrastrar
     al timeline. Sustituye a las pestañas Clips/Music del modo Edit.
   - Pistas: cortar (split), mover entre pistas, recortar bordes, ripple, enlazar/desenlazar audio y vídeo, cortar
     audio, fundidos, velocidad.
   - Color: corrección por clip (exposición, contraste, temperatura, saturación…), LUTs y **presets** de look.
   - Formato y resolución del proyecto: cambiar vertical/horizontal/cuadrado (reencuadre automático 16:9→9:16) y la
     resolución de trabajo y de export.
   - Subtítulos karaoke con estilos, audio (ruido y normalizar el volumen), atajos J/K/L-C-V, deshacer/rehacer,
     autoguardado, export XML/OTIO.
3. Agente editor: "graba y suéltalo" (cortes, material, motion, subtítulos, música, revisión) + publicar en redes.
4. Color avanzado: scopes, nodos, igualar entre clips, gestión de color, HDR.
5. Visor nativo en Windows (DX12) y Linux (Vulkan); MCP remoto (HTTP) para claude.ai web/móvil.

**Repositorio público desde el 2026-10-24** (decisión de Sergio), MIT a su nombre. Queda hablar con el socio sobre
la propiedad intelectual y revisar la cláusula del contrato de trabajo.
