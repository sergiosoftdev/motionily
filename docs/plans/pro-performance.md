# Rendimiento y funciones de editor profesional (pedido el 2026-10-27)

Reglas como en [resolve-parity.md](resolve-parity.md): cada punto con su UI, tool MCP o docs cuando toca, test, prueba
en la app real y un commit por punto en `main`.

## Orden y estado

| # | Punto | Estado |
|---|---|---|
| 1 | Medir: panel de rendimiento (fps, render, decodificación, memoria) y benchmarks con escenas pesadas | hecho |
| 6 | Atajos de teclado configurables con presets de Premiere, Resolve y Final Cut | hecho |
| 11 | Timecode SMPTE en todo el editor, con entrada numérica para ir a un fotograma | hecho |
| 7 | Audio al arrastrar el cabezal y medidores LUFS / pico en vivo | hecho |
| 2 | Vídeo sin copias en la web: el `VideoFrame` de WebCodecs directo a la GPU | hecho |
| 3 | Decodificación nativa en escritorio (VideoToolbox / Media Foundation) en lugar de ffmpeg por tubería | hecho (Windows sin probar en una máquina Windows) |
| 4 | El motor de reproducción en un worker con `OffscreenCanvas` | pendiente |
| 5 | Caché de capas estáticas y exportación que reutiliza la caché de render | hecho (ver notas) |
| 8 | Chroma key y luma key | hecho |
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

## Punto 2 medido (clip 1080p H.264 sin proxy, reproducción en el editor, WebGPU)

| camino | subida p50 (CPU) | GPU por fotograma p50 / p95 | fps |
|---|---|---|---|
| canvas 2D + copia (antes) | 0,2 ms | 3,6 / 6,6 ms | 30 |
| `VideoFrame` directo (ahora) | 0,1 ms | 3,5 / 7,1 ms | 30 |

A 1080p ninguno de los dos pierde fotogramas; el cambio quita el dibujo 2D de cada fotograma (que el navegador hace
en la GPU) y el canvas intermedio de 8 MB por clip. La ganancia real aparece con varios clips o 4K a la vez.

## Punto 3 medido (clip 1080p H.264, `cargo run -p native-video --release --example compare -- clip.mp4`)

| | nativo (AVFoundation / VideoToolbox) | ffmpeg por tubería (antes) |
|---|---|---|
| saltar a un tiempo (mediana de 20) | 28 ms | 222 ms |
| decodificar todo el clip | 2,9 ms/fotograma | 3,6 ms/fotograma |

Windows (Media Foundation) compila para `x86_64-pc-windows-msvc` pero no se ha ejecutado: falta probarlo en Windows,
sobre todo el sentido de `MF_MT_VIDEO_ROTATION`.

## Punto 5 medido

Las capas con efectos se dibujaban en texturas de fotograma completo y cada blur eran dos pasadas a pantalla completa:
ahora cada capa sólo sombrea su alcance (`DrawFx::reach`: la capa, sus muestras de motion blur y lo que extiende cada
efecto). Un fotograma idéntico al anterior (planos fijos, pausas, exportaciones con tramos quietos) no se vuelve a dibujar
en el visor nativo ni en `render_rgba` (exportaciones de escritorio, stills).

| | antes | ahora |
|---|---|---|
| effects_40 nativo 1080×1920, p50 | 128 ms | 29 ms |
| effects_40 navegador 540×960, GPU p50 | 38 ms | 14 ms |
| exportar 6 s con 5 s de plano fijo (nativo) | 979 ms | 240 ms |

Un test compara píxel a píxel el dibujo recortado con el de pantalla completa (sombras, glows con umbral, blur,
overlay, texto, motion blur): diferencia máxima ≤ 2/255. No hecho: una caché por capa entre fotogramas distintos
(costaría una textura de fotograma completo por capa) ni reutilizar en la exportación web la caché de render del
editor (guarda los fotogramas al tamaño de la previsualización, menor que el de exportación).
