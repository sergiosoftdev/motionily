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
| 3 | Decodificación nativa en escritorio (VideoToolbox / Media Foundation) en lugar de ffmpeg por tubería | hecho (Windows probado en un runner Windows) |
| 4 | El motor de reproducción en un worker con `OffscreenCanvas` | hecho (el worker usa el mismo backend que el editor) |
| 5 | Caché de capas estáticas y exportación que reutiliza la caché de render | hecho (ver notas) |
| 8 | Chroma key y luma key | hecho |
| 9 | Multicámara | hecho |
| 10 | Importar timelines (FCPXML, OTIO) | hecho (también Final Cut Pro 7 XML, el "XML" de Premiere) |

## Notas

- Punto 2: el motor ya sube con `copy_external_image_to_texture` (wgpu 30), pero desde un canvas 2D en el que
  `VideoFile.drawCurrent` pinta cada fotograma; la mejora es pasarle el `VideoFrame` del decodificador.
- Punto 3: el visor nativo (`apps/desktop/src-tauri/src/ffmpeg.rs`) lanza ffmpeg con `-f rawvideo -pix_fmt rgba` por clip
  y lo relanza en cada salto.

- Punto 10: `scene::timeline_import` lee FCPXML 1.9–1.11 (storyline principal, clips conectados, `clip`/`gap`/
  storylines secundarias, `tcStart` y medios con timecode, `media-rep`), FCP7 XML (archivos por id, pares estéreo) y
  OTIO (`Clip.1/2`, `media_references`, rangos disponibles con timecode). El sonido propio de un clip que viene aparte
  se descarta (la capa de vídeo ya suena) y los solapes pasan a la pista libre siguiente. Edit › Media › "Import
  timeline…" y la tool `import_timeline`; en escritorio se copian los archivos desde su ruta original, en el navegador
  se piden. Fuera: títulos, generadores, secuencias anidadas, multicámara y cambios de velocidad (se listan).

- Punto 9: un clip de vídeo lleva sus ángulos en `multicam` (`{group, angle, angles:[{src, offset, name}]}`, sin efecto
  en el render). "Make multicam" en el inspector sincroniza cada cámara con el sonido del clip (la sincronización por
  forma de onda de `sync_audio`, ±60 s; −2,500 s exactos en la prueba) y pasa su sonido a una capa de audio debajo, así
  los cortes no saltan en el audio. Cambiar de ángulo corta en el cabezal y apunta el resto a la otra cámara en el mismo
  instante (rechaza donde esa cámara no grababa). Visor de ángulos bajo el programa (clic = corte), teclas 1–9 en
  directo durante la reproducción y la tool `multicam`.

- Punto 4: al reproducir, un worker con su propio motor (`Engine.createOffscreen`) y sus propios decodificadores
  dibuja en un canvas transferido encima del del editor, con su reloj sincronizado con el del sonido cada 250 ms;
  en pausa vuelve el canvas del editor (gizmos, selección, edición). Mismo patrón que el visor nativo de escritorio,
  que tiene prioridad. Con el hilo principal ocupado el 67 % del tiempo (80 ms de cada 120): 107 fotogramas en el
  worker frente a 18 en el hilo principal en el mismo intervalo (≈29 frente a ≈5 fps). Ajustes › Playback lo apaga.
  El worker pide a wgpu el mismo backend que el motor del editor (`createOffscreen(canvas, webgl)`): con WebGL2 los
  fotogramas le llegan por un `OffscreenCanvas` (`setVideoFrameOffscreen`). La build web actual compila wgpu sin la
  feature `webgl`, así que en el navegador el motor es sólo WebGPU y el worker cubre todos los casos que hay hoy.
  Fuera: el scrub y la edición siguen en el hilo principal.

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

Windows (Media Foundation) probado en un runner `windows-latest` de GitHub Actions (una vez, 2026-10-27; el workflow
se quitó después para no gastar minutos): `cargo test -p native-video` pasa, incluidas las rotaciones de 90°, 180° y
270° comparadas píxel a píxel con el fotograma derecho de ffmpeg (diferencia media < 8/255). En Mac pasan en local
(ffmpeg 9); en el runner `macos-14` el de 90° dio 40/255 con la misma transformación leída que en local, así que la
diferencia está en el fotograma de referencia de su ffmpeg, no en el giro (girado al revés daría 122).

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
(costaría una textura de fotograma completo por capa).

La exportación web reutiliza los fotogramas ya calculados: `Engine.renderChanged(t)` no dibuja un fotograma que pinta
exactamente lo mismo que el anterior (misma lista de capas, sin vídeo avanzando) y la exportación vuelve a codificar la
muestra que ya tenía (`VideoSample.clone()` con otro timestamp), sin render ni lectura de la GPU. Un plano fijo de 1 s a
30 fps: 1 fotograma dibujado, 29 reutilizados (`ExportResult.frames`). Exportar 3 s a 720×1280 (12 círculos con glow y
sombra, 1 s en movimiento y 2 s quietos) en el navegador: 5536 ms dibujando cada fotograma, 358 ms reutilizando (31
dibujados, 59 reutilizados). La caché de render del editor no sirve aquí:
guarda los fotogramas al tamaño de la previsualización, menor que el de exportación.
