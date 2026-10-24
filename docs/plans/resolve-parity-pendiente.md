# Pendiente del plan Resolve (a 2026-10-25)

Plan completo y reglas en [resolve-parity.md](resolve-parity.md) (cada punto: op/campo de escena + UI + tool MCP +
`docs/agent` + test + prueba real; commit por punto en `main`).

## Hecho
Fase 0 · 1.1–1.4 · 2.1 scopes · 2.2 ruedas y curvas · 2.3 LUTs · 3.4 bus master y normalizar · 4.2–4.6 · 5.4 versiones.
2.4 ventanas: hecho (0fdf003) salvo la prueba del tracking.

## Por hacer, en este orden

### Cerrar 2.4 ventanas
- Probar `track_window` de punta a punta. Proyecto "Tracking test" (API local 3100, cuenta `colortest@local.dev`,
  `6add2592…`) con `moving.mp4`: el sujeto va de (420, 540) a (1095, 720) en escena entre 0 y 3 s. Añadir el clip, una
  ventana en (420, 540), `track_window` en t=0 y comprobar los keyframes (error < ~10 px).
- Revisar en la app de escritorio la pestaña Color › Window (sliders, Outside, Track, Delete).

### 2.5 Igualar color y copiar/pegar grade
- `match_color {from, to[]}`: transferencia de media y desviación en Lab entre los frames medios de los clips, escrita
  como ruedas (gain/lift/offset) y saturación del efecto `color`; botón "Match to…" en la pestaña Color.
- Copiar/pegar grade (todo el efecto `color`, LUT incluida) entre clips: menú del clip + ⌥⌘C / ⌥⌘V.

### 2.6 Gestión de color
- Transformación de entrada Log → Rec.709 por clip (`input`: apple_log | slog3 | vlog | clog3) antes del grade, en el
  shader de composición; selector en la pestaña Color; docs con las curvas exactas.

### 3.1 Mezclador
- Por pista: volumen, pan, mute y solo (sobre `tracks`); `pan` en clips de audio y vídeo; panel Mixer en Edit;
  aplicado igual en preview (bus) y en los exports.

### 3.2 EQ, compresor y limitador
- `audio_fx` por clip y en el máster (EQ de 3–5 bandas, compresor, limitador a −1 dBTP); WebAudio en preview y en
  `mixAudio`; el limitador permite que `normalize_loudness` llegue al objetivo cuando hoy lo frena el pico.

### 3.3 Reducción de ruido y aislar voz
- Medio procesado nuevo y no destructivo con ffmpeg (`afftdn` / `arnndn`) desde el pool y la tool `clean_audio`.

### 1.5–1.7 Edición avanzada
- 1.5 Clips compuestos: agrupar clips (vídeo y audio) en uno y abrirlo (sobre precompose).
- 1.6 Rampas de velocidad con curva (sobre `time=`) y estabilización (ffmpeg vidstab como medio nuevo).
- 1.7 Sincronizar audio por forma de onda (correlación cruzada con el audio de cámara).

### 4.1 Cola de render
- Presets (Reels/TikTok, YouTube 1080/4K, máster ProRes) y cola en el escritorio; tool `queue_export`.

### Fase 5 — Medios
- 5.1 Proxies a 540p para el preview (el export usa originales).
- 5.2 Re-enlazar medios que faltan (buscar en una carpeta por nombre y tamaño).
- 5.3 Carpetas (bins) y búsqueda en el pool.

### Fase 6 — Rendimiento
- 6.1 Visor nativo en Windows (DX12, ventana hija) y Linux (necesita esas máquinas para probar).
- 6.2 Caché de render en segundo plano para tramos pesados.

## Bugs vistos
- Motor nativo (visor de escritorio y export nativo): una capa de vídeo más alta que el cuadro (p. ej. 1080×2484 en
  9:16) se dibuja cortada abajo con cámara (franja con otro encuadre). El motor web lo pinta bien. Esquivado en el vídeo
  "Every AI Video Looks the Same" con un muro de 1080×1920; arreglar en el motor nativo (cf. el bug de texto >1920 px).
- El lint auto-corrige capas que salen del cuadro a propósito (muros, bandas) y colores sobre fondos con keys de color
  (lee el primer color): debería respetar capas mayores que el cuadro y evaluar el fondo en el instante del texto.

## Notas técnicas
- La API local (3100) corre desde `apps/api/dist`; su `tsc -w` se queda colgado: recompilar con
  `npx tsc -p tsconfig.build.json` en `apps/api`.
- Tras cambiar ops del motor: `pnpm wasm`.
- App empaquetada: `pnpm --filter @motionily/desktop build` → `target/release/bundle/macos/Motionily.app`, copiar a
  `/Applications` con la app cerrada.
- La música del preview sigue siendo un `<audio>` por el bus con resincronización por deriva; si da tirones en
  WebKit, pasarla a buffer como la voz (`apps/web/src/audio/voice.ts`).
