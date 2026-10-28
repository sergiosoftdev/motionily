# Aprender de las estadísticas

Objetivo: que cada vídeo nuevo salga mejor que el anterior porque Motionily sabe qué ha funcionado en
**tu** cuenta, no en general. El agente no se reentrena: aprende porque cada vez que abre un vídeo lee
el historial de tu canal, ordenado y con su nivel de confianza.

El bucle:

1. **Qué hicimos.** Rasgos de cada vídeo publicado, sacados de su escena: la frase con la que abre
   (voz o texto en pantalla), duración, ritmo (elementos nuevos por minuto), palabras por segundo,
   voz, subtítulos, música, género y formato (`apps/api/src/social/features.ts`).
2. **Qué pasó.** Las métricas de cada plataforma, y además una foto a 1, 3 y 7 días, para comparar
   vídeos con la misma edad (un vídeo de hace un mes no compite con uno de ayer).
3. **Qué aprendemos.** Los mejores vídeos (tercio superior por views a 3 días) contra el resto: gancho,
   ritmo, duración, voz, plataforma, shares. Solo diferencias con las que actuar, con una etiqueta de
   confianza según cuántos vídeos hay detrás (temprano < 8, tomando forma < 20, sólido).
4. **Cómo lo usa.** `get_project` termina con el playbook del canal (vídeo del que aprender con su
   gancho, el más flojo, los patrones y los vídeos que aún crecen), así que cualquier vídeo nuevo empieza
   desde lo que funcionó sin que nadie lo pida. `get_channel_insights` da la lista completa.

## Hecho (fase 1)

- Fotos de métricas a 1/3/7 días (`checkpoints` en el post) y rasgos (`features`).
- Vídeos de menos de 3 días: se ven como "Growing", no entran en las comparaciones.
- Confianza visible en Stats y en lo que lee el agente.
- Comparaciones por gancho, ritmo y voz, además de skip, visto, duración, plataforma y shares.
- Playbook automático en `get_project`.

## Hecho (fase 2): experimentos

Cada vídeo declara qué prueba ("gancho con pregunta en vez de dato", "15 s en vez de 30") y qué número
debería mover (gancho, % visto, views, shares, guardados): el agente con `set_experiment` al planearlo,
o el usuario en Schedule. A los 3 días se compara con la mediana de los demás vídeos (misma plataforma
si hay al menos dos): funcionó, no funcionó o sin cambio claro. Stats lo enseña y el playbook de
`get_project` lista cada resultado, así el agente construye sobre lo que funcionó y no repite lo que no.

## Hecho (fase 3): dónde se va la gente

Cada post guarda su línea de tiempo: qué entra en pantalla y cuándo, clasificado por lo que es para quien
mira (gráfico, tabla, mapa, pantalla de app, clip, imagen, título, texto…: primero por el id, grupo o
componente de la capa, después por su tipo). Con la curva de retención de YouTube, `channelDropoffs`
mide cuánta audiencia se va en los 2 s después de que aparece cada tipo de cosa, contra la pendiente
normal alrededor en el mismo vídeo (mediana, para que otra caída cerca no la falsee), sin el gancho ni el
final. Un patrón sale con 3 momentos en 2 vídeos y una diferencia clara: "cuando aparece una tabla se va
un 18% en 2 s, lo normal ahí es un 3%". También "nada nuevo en 3 s". Stats lo enseña ("Where viewers
leave", con las caídas más fuertes y qué había en pantalla) y el playbook se lo da al agente. Instagram y
TikTok no dan curva: solo el skip de 3 s, que ya cuenta para el gancho.

## Siguiente

- **Hora de publicar.** Views a 3 días por día y franja horaria; el Schedule propone la mejor franja.
- **Comentarios.** Leer los comentarios (Instagram y YouTube lo permiten) para sacar preguntas
  repetidas: ideas de siguiente vídeo y del tono que gusta.
- **Contra tu propio ritmo.** Avisar cuando un vídeo va por encima o por debajo de lo normal a las
  24 h, para repostearlo o cortarlo distinto.
