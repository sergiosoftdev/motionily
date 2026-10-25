# Plan: Motionily competitivo con DaVinci Resolve (con el agente al mismo nivel que el humano)

Pedido por Sergio el 2026-10-24. Estética CapCut, funciones de Resolve, y **todo lo que puede hacer una persona lo puede
hacer el agente** (cualquier cliente MCP).

## Regla de cada punto (definición de hecho)
1. **Motor/escena**: la función es un campo o una op de `crates/scene` (lo que se guarda y se renderiza igual en el
   preview, en el export web y en el export nativo).
2. **UI**: el control en el editor (Edit, y Pro cuando aplique) escribe esa op; nada vive solo en la UI ni en
   `localStorage` si cambia el vídeo.
3. **MCP**: el agente puede hacerlo con una tool o con `apply_ops`/`add_layers`, y lee el estado que necesita.
4. **Docs**: semántica exacta en `docs/agent` (fórmulas, valores, límites).
5. **Test**: test de Rust para el motor, e2e de API cuando toca la API, typecheck de todo, y prueba en la app real.
6. Commit por punto, en `main`.

## Fase 0 — Paridad del agente (lo que hoy solo puede hacer el humano)
- 0.1 **Ajustes de salida en el proyecto**: resolución, fps y códec en la escena (`output`), op `set_output`; Project
  settings y Export los leen; tool `set_output` y su línea en `get_project`.
- 0.2 **Media Pool para el agente**: `get_project` lista los medios (clips, sonidos, fotos con URL, duración y tamaño);
  tool `import_media` (desde una URL o una ruta local en escritorio) y `remove_media`.
- 0.3 **Exportar desde el agente**: tool `export_video` (formato, resolución, códec, rango); el editor exporta (nativo en
  escritorio) y devuelve la ruta del archivo.
- 0.4 **Proyecto como carpeta**: tools `save_project_folder` / `open_project_folder` (escritorio).
- 0.5 **Looks compartidos**: los presets de color pasan a `@motionily/protocol` y a `docs/agent`; op `apply_look`
  (por nombre) para que el agente y la UI apliquen exactamente lo mismo.

## Fase 1 — Edición
- 1.1 **Pistas fijas** (V1…Vn, A1…An) con nombre, bloquear, silenciar, solo y ocultar: `tracks` en la escena, campo
  `track` en cada clip; el motor no dibuja una pista oculta y no suena una silenciada (o no-solo). Ops `set_track`.
- 1.2 **Recortes de Resolve**: ripple trim, roll, slip y slide como ops del motor (`trim_edit`), herramientas en la
  barra (A selección, B cuchilla, T recorte) y en el MCP.
- 1.3 **Marcas I/O e inserciones**: entrada/salida en el timeline (I, O), `insert`, `overwrite` y `replace` de un medio
  del pool (op `place_clip` con modo); J/K/L (atrás, pausa, adelante, más rápido al repetir).
- 1.4 **Marcadores** en el timeline de Edit (M añade, doble clic renombra), sobre `set_markers`.
- 1.5 **Clips compuestos**: agrupar clips en uno (precompose para vídeo y audio) y abrirlo.
- 1.6 **Rampas de velocidad** con curva (sobre `time=`), **estabilización** (ffmpeg vidstab como medio nuevo, no
  destructivo).
- 1.7 **Sincronizar audio por forma de onda** (correlación cruzada; un clip con el audio externo de la cámara).

## Fase 2 — Color
- 2.1 **Scopes**: waveform, parade, vectorscopio e histograma en el editor; tool `color_scopes` con números (percentiles
  de luma, medias RGB, saturación, dominantes) para que el agente vea como un colorista.
- 2.2 **Ruedas y curvas**: lift/gamma/gain/offset y curvas (master, R, G, B) en el efecto `color`.
- 2.3 **LUTs .cube** (textura 3D en el motor), importables al pool y aplicables por clip.
- 2.4 **Ventanas (máscaras)** de corrección: rectángulo/elipse con suavizado, sobre el grade de un clip; tracking por
  plantilla que escribe keyframes.
- 2.5 **Igualar color** entre clips (transferencia de media y desviación en Lab) y copiar/pegar grade; tool
  `match_color`.
- 2.6 **Gestión de color**: entrada Log (Apple Log, S-Log3, V-Log, C-Log) a Rec.709 como transformación de entrada.

## Fase 3 — Audio
- 3.1 **Mezclador** por pista: volumen, panorama, mute/solo (con 1.1); `pan` en clips.
- 3.2 **EQ, compresor y limitador** por clip y en el máster (`audio_fx`), iguales en el preview y en el export.
- 3.3 **Reducción de ruido y aislar voz** (ffmpeg afftdn/arnndn) como medio procesado nuevo, no destructivo.
- 3.4 **Normalizar a −14 LUFS** (o el objetivo que elijas) midiendo la mezcla (ebur128); tool `normalize_loudness`.

## Fase 4 — Exportar
- 4.1 **Cola de render** con presets (Reels/TikTok, YouTube 1080/4K, máster ProRes) en escritorio.
- 4.2 **Transparencia**: ProRes 4444 / WebM VP9 con alfa.
- 4.3 **fps** del proyecto: 23.976, 24, 25, 29.97, 30, 50, 60.
- 4.4 **SRT** de los subtítulos.
- 4.5 **FCPXML / OTIO / EDL** del timeline de Edit.
- 4.6 **Exportar un tramo** (entrada–salida).

## Fase 5 — Medios
- 5.1 **Proxies** (ffmpeg a 540p) para el preview; el export usa los originales.
- 5.2 **Re-enlazar** medios que faltan (buscar en una carpeta por nombre y tamaño).
- 5.3 **Carpetas (bins) y búsqueda** en el Media Pool.
- 5.4 **Versiones**: instantáneas de la escena (manuales y automáticas) y restaurar.

## Fase 6 — Rendimiento
- 6.1 Visor nativo en Windows (DX12, ventana hija) y Linux.
- 6.2 Caché de render en segundo plano para tramos pesados.

## Orden
0 → 1.1–1.4 → 2.1–2.2 → 3.4 → 4.3–4.6 → 2.3–2.6 → 3.1–3.3 → 1.5–1.7 → 4.1–4.2 → 5 → 6. Cada punto se marca aquí al
terminarlo, con su commit.

## Estado
- [x] 0.1–0.4 salida en la escena, media pool, export y carpetas para el agente (95ae7c4, b3808ad)
- [x] 0.5 looks compartidos y `apply_look` (b3808ad)
- [x] 5.4 versiones (0802cba)
- [x] 1.1 pistas (4edea67)
- [x] 1.2 ripple/roll/slip/slide (f5797c4)
- [x] 1.3–1.4 I/O, insert/overwrite/replace, J/K/L, marcadores (a951f11)
- [x] 4.2 transparencia, 4.3 fps, 4.6 tramo (95ae7c4)
- [x] 2.2 ruedas y curvas (f2744ed)
- [x] 2.1 scopes y `color_scopes` (a4886f6)
- [x] 3.4 bus de mezcla con master (`set_mix`) y `normalize_loudness` (BS.1770, medido igual que ffmpeg ebur128) (a6baab0)
- [x] 4.4 SRT/VTT y 4.5 FCPXML/OTIO/EDL (`export_file`; OTIO validado con opentimelineio, FCPXML con xmllint) (dae2456)
- [x] 2.3 LUTs `.cube` (pool, textura 3D en motor web y nativo, `lut`/`lut_mix`)
- [x] 2.4 ventanas: capa de ajuste rect/elipse con `soft`, `invert`, `attach` al clip; pestaña Color (Clip / Window n), tracking NCC (`track_window`) probado de punta a punta en "Tracking test": error < 1,5 px (0fdf003, 303b400)
- [x] 2.5 `match_color` (media y desviación por canal → `gain`/`offset`, 3 rondas medidas; ΔE 8,0 → 1,1 en la prueba) y copiar/pegar grade (`copy_grade`, ⌥⌘C/⌥⌘V, botones en Color)
- [x] 2.6 gestión de color: `input` del efecto color (Apple Log, S-Log3, V-Log, Canon Log 3 → Rec.709 2.4, gamut + roll-off), selector "Camera log" en Color; test GPU de gris medio
- [x] 3.1 mezclador: `volume`/`pan` por pista, `pan` por clip, canales voz/música/efectos en `mix.channels` (solo global), sección Mixer en Project settings; preview = export (test de muestras), fader −6 dB → −6 LUFS
- [ ] Siguiente: 3.2–3.3 → 1.5–1.7 → 4.1 → 5.1–5.3 → 6
