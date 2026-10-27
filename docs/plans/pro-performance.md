# Rendimiento y funciones de editor profesional (pedido el 2026-10-27)

Reglas como en [resolve-parity.md](resolve-parity.md): cada punto con su UI, tool MCP o docs cuando toca, test, prueba
en la app real y un commit por punto en `main`.

## Orden y estado

| # | Punto | Estado |
|---|---|---|
| 1 | Medir: panel de rendimiento (fps, render, decodificación, memoria) y benchmarks con escenas pesadas | hecho |
| 6 | Atajos de teclado configurables con presets de Premiere, Resolve y Final Cut | hecho |
| 11 | Timecode SMPTE en todo el editor, con entrada numérica para ir a un fotograma | hecho |
| 7 | Audio al arrastrar el cabezal y medidores LUFS / pico en vivo | pendiente |
| 2 | Vídeo sin copias en la web: el `VideoFrame` de WebCodecs directo a la GPU | pendiente |
| 3 | Decodificación nativa en escritorio (VideoToolbox / Media Foundation) en lugar de ffmpeg por tubería | pendiente |
| 4 | El motor de reproducción en un worker con `OffscreenCanvas` | pendiente |
| 5 | Caché de capas estáticas y exportación que reutiliza la caché de render | pendiente |
| 8 | Chroma key y luma key | pendiente |
| 9 | Multicámara | pendiente |
| 10 | Importar timelines (FCPXML, OTIO) | pendiente |

## Notas

- Punto 2: el motor ya sube con `copy_external_image_to_texture` (wgpu 30), pero desde un canvas 2D en el que
  `VideoFile.drawCurrent` pinta cada fotograma; la mejora es pasarle el `VideoFrame` del decodificador.
- Punto 3: el visor nativo (`apps/desktop/src-tauri/src/ffmpeg.rs`) lanza ffmpeg con `-f rawvideo -pix_fmt rgba` por clip
  y lo relanza en cada salto.

## Cifras de partida (punto 1, MacBook con Apple Silicon, p50 por fotograma hasta que la GPU termina)

| escena | nativo 1080×1920 | nativo 540×960 | navegador WebGPU 540×960 |
|---|---|---|---|
| texts_200 | 2,5 ms | 1,2 ms | 1,8 ms |
| shapes_800 | 2,5 ms | 1,1 ms | 1,4 ms |
| effects_40 (glow + blur + sombra ×40, 3 grades) | 128 ms | 44 ms | 38 ms |
| after-effects (ejemplo, 1920×1080) | 6,6 ms | 4,1 ms | – |

Los efectos apilados son el cuello de botella real (punto 5).
