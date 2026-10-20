/** Shown after a voice-over lands on a video that already has scenes: offers to rebuild it around the voice. */
export function VoiceSyncDialog({ onAdapt, onKeep }: { onAdapt: () => void; onKeep: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-neutral-900 p-6 ring-1 ring-white/10">
        <h4 className="text-base font-semibold text-white">¿Adaptar el vídeo al ritmo de la voz?</h4>
        <p className="text-sm leading-relaxed text-neutral-400">
          El agente transcribe la voz y vuelve a montar las escenas con los tiempos de cada frase. Se reemplaza el vídeo actual.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onKeep} className="rounded-lg px-3 py-2 text-sm text-neutral-300 hover:bg-white/5 hover:text-white">
            Ahora no
          </button>
          <button type="button" onClick={onAdapt} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200">
            Adaptar el vídeo
          </button>
        </div>
      </div>
    </div>
  );
}
